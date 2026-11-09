import type { ComfyClient } from "../client/index.js";
import { queueEntryPromptId, type HistoryEntry } from "../client/types.js";
import { harvestOutputRefs, type AssetManager } from "../assets/asset-manager.js";
import { IN_FLIGHT_STATUSES, type BatchStore, type JobRow, type JobError, type JobOutputAsset } from "./store.js";

const HISTORY_POLL_MS = 3_000;
export interface TrackerDeps {
  client: ComfyClient;
  store: BatchStore;
  assets: AssetManager;
  autoSave: boolean;
  defaultTimeoutMs: number;
}
interface Tracked {
  job: JobRow;
  unsubscribe: () => void;
  pollTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  settled: boolean;
  asyncSettle: Promise<void> | null;
  cancelInFlight: boolean;
  sawInterrupted: boolean;
}

/** ComfyUI 0.41 writes interruptions as status_str=error with a terminal message. */
export function historyVerdict(entry: { status?: Record<string, unknown>; outputs?: Record<string, unknown> }): "success" | "error" | "interrupted" | null {
  const status = entry.status;
  const messages = Array.isArray(status?.["messages"]) ? status["messages"] : [];
  for (const message of [...messages].reverse()) {
    if (!Array.isArray(message)) continue;
    if (message[0] === "execution_interrupted") return "interrupted";
    if (message[0] === "execution_error") return "error";
  }
  if (status?.["status_str"] === "error") return "error";
  if (status?.["status_str"] === "success" && status["completed"] === true) return "success";
  return null;
}

export class JobTracker {
  private readonly tracked = new Map<string, Tracked>();
  private stopping = false;
  constructor(private readonly deps: TrackerDeps) {}

  get timeoutMs(): number {
    return this.deps.defaultTimeoutMs;
  }
  isTracked(jobId: string): boolean {
    return this.tracked.has(jobId);
  }
  disposeAll(): void {
    for (const t of [...this.tracked.values()]) this.release(t);
  }

  resume(): void {
    this.stopping = false;
  }

  /** Graceful stop drains collection before the DB is closed. Hard process
   * termination instead relies on persisted intent and recovery. */
  async stop(): Promise<void> {
    this.stopping = true;
    const active = [...this.tracked.values()];
    for (const t of active) {
      t.unsubscribe();
      if (t.pollTimer) clearInterval(t.pollTimer);
      if (t.timeoutTimer) clearTimeout(t.timeoutTimer);
    }
    await Promise.all(active.map((t) => t.asyncSettle));
    this.disposeAll();
  }

  private active(t: Tracked): boolean {
    if (t.settled || this.tracked.get(t.job.id) !== t) return false;
    const current = this.deps.store.getJobById(t.job.id)!;
    return current.attempt_no === t.job.attempt_no && current.prompt_id === t.job.prompt_id && IN_FLIGHT_STATUSES.includes(current.status);
  }

  track(job: JobRow): void {
    if (this.stopping || !job.prompt_id || this.tracked.has(job.id)) return;
    const t: Tracked = {
      job,
      unsubscribe: () => {},
      pollTimer: null,
      timeoutTimer: null,
      settled: false,
      asyncSettle: null,
      cancelInFlight: false,
      sawInterrupted: false
    };
    this.tracked.set(job.id, t);
    const attempt = this.deps.store.getAttempt(job);
    // Pre-v4 attempts use their original submission time, never a fresh timeout period.
    const deadline = attempt?.deadline_at ?? new Date(Date.parse(job.submitted_at ?? new Date().toISOString()) + this.timeoutMs).toISOString();
    if (attempt && !attempt.deadline_at) this.deps.store.patchAttempt(job, { deadline_at: deadline });
    t.unsubscribe = this.deps.client.bus.subscribePrompt(job.prompt_id, (event) => {
      if (!this.active(t)) return;
      switch (event.type) {
        case "started":
        case "executing":
          this.updateInFlight(t, "executing");
          break;
        case "success":
          this.deps.store.patchAttempt(job, { success_observed_at: new Date().toISOString() });
          if (t.timeoutTimer) clearTimeout(t.timeoutTimer);
          void this.reconcile(job.id);
          break;
        case "error":
          this.settle(t, "failed", { code: "EXECUTION_ERROR", message: event.message.slice(0, 500) });
          break;
        case "interrupted":
          this.settleInterrupted(t);
          break;
      }
    });
    t.pollTimer = setInterval(() => void this.reconcile(job.id), HISTORY_POLL_MS);
    t.pollTimer.unref();
    if (!attempt?.cancel_requested_at && !attempt?.success_observed_at) {
      t.timeoutTimer = setTimeout(() => void this.handleTimeout(t), Math.max(0, Date.parse(deadline) - Date.now()));
      t.timeoutTimer.unref();
    }
  }

  /** One serialized collection per attempt, shared by recovery, WS and polling. */
  async reconcile(jobId: string): Promise<void> {
    const t = this.tracked.get(jobId);
    if (!t || !this.active(t)) return;
    t.asyncSettle ??= this.inspect(t).finally(() => { t.asyncSettle = null; });
    await t.asyncSettle;
  }

  private async inspect(t: Tracked): Promise<void> {
    let history: HistoryEntry | null;
    try {
      history = await this.deps.client.http.getHistory(t.job.prompt_id!);
    } catch (error) {
      if (this.active(t)) this.updateInFlight(t, undefined, { code: "RECONCILIATION_FAILED", message: `history query failed: ${String(error).slice(0, 200)}` });
      return;
    }
    if (!this.active(t)) return;
    if (history) {
      const verdict = historyVerdict(history);
      if (verdict === "interrupted") {
        this.settleInterrupted(t);
        return;
      }
      if (verdict === "error") {
        this.settle(t, "failed", { code: "EXECUTION_ERROR", message: "history confirms execution_error" });
        return;
      }
      if (verdict === "success") {
        await this.collect(t, history);
        return;
      }
    }
    const attempt = this.deps.store.getAttempt(t.job);
    if (attempt?.success_observed_at) {
      this.updateInFlight(t, "submission_unknown", { code: "RESULT_PENDING", message: "Execution succeeded; waiting for history/results. Generation will not be retried." });
      return;
    }
    let queue;
    try {
      queue = await this.deps.client.http.getQueue();
    } catch (error) {
      if (this.active(t)) this.updateInFlight(t, undefined, { code: "RECONCILIATION_FAILED", message: `queue query failed: ${String(error).slice(0, 200)}` });
      return;
    }
    if (!this.active(t)) return;
    if (attempt?.cancel_requested_at) {
      this.updateInFlight(t, "submission_unknown", { code: "TIMEOUT_UNCONFIRMED", message: "Local deadline exceeded; remote termination is unconfirmed. Window remains occupied; no automatic resubmission." });
    } else if (queue.queue_running.some((q) => queueEntryPromptId(q) === t.job.prompt_id)) {
      this.updateInFlight(t, "executing");
    } else if (queue.queue_pending.some((q) => queueEntryPromptId(q) === t.job.prompt_id)) {
      this.updateInFlight(t, "queued");
    } else {
      this.updateInFlight(t, "submission_unknown", { code: "SUBMISSION_UNKNOWN", message: "Successful history and queue queries found no terminal record or queued prompt. Retaining remote uncertainty; no resubmission." });
    }
  }

  private async handleTimeout(t: Tracked): Promise<void> {
    if (!this.active(t)) return;
    const attempt = this.deps.store.getAttempt(t.job);
    if (attempt?.success_observed_at || attempt?.cancel_requested_at) return;
    // Persist the reason BEFORE either remote call; a crash cannot erase intent.
    this.deps.store.transaction(() => {
      this.deps.store.patchAttempt(t.job, { cancel_requested_at: new Date().toISOString() });
      this.updateInFlight(t, "submission_unknown", { code: "TIMEOUT_UNCONFIRMED", message: "Local deadline exceeded; cancellation requested, remote outcome pending." });
    });
    const remote = { queue_delete: "skipped", interrupt: "skipped" };
    t.cancelInFlight = true;
    try {
      await this.deps.client.http.deleteQueue([t.job.prompt_id!]);
      remote.queue_delete = "ok";
    } catch (error) {
      remote.queue_delete = `error: ${String(error)}`.slice(0, 200);
    }
    if (!this.active(t)) return;
    try {
      await this.deps.client.http.interrupt(t.job.prompt_id!);
      remote.interrupt = "ok";
    } catch (error) {
      remote.interrupt = `error: ${String(error)}`.slice(0, 200);
    }
    if (!this.active(t)) return;
    this.updateInFlight(t, "submission_unknown", { code: "TIMEOUT_UNCONFIRMED", message: "Cancellation RPC completed; awaiting remote terminal evidence (HTTP 200 alone is insufficient).", remote_cancel: remote });
    t.cancelInFlight = false;
    if (t.sawInterrupted) {
      this.settleInterrupted(t);
      return;
    }
    await this.reconcile(t.job.id);
  }

  private settleInterrupted(t: Tracked): void {
    if (t.cancelInFlight) {
      t.sawInterrupted = true;
      return;
    }
    const timeout = this.deps.store.getAttempt(t.job)?.cancel_requested_at;
    this.settle(t, timeout ? "timeout" : "cancelled", {
      code: timeout ? "TIMEOUT" : "INTERRUPTED",
      message: timeout ? "Remote execution_interrupted confirmed after persisted local timeout cancellation." : "User/external interruption confirmed; never automatically retried."
    });
  }

  private async collect(t: Tracked, history: HistoryEntry): Promise<void> {
    this.deps.store.patchAttempt(t.job, { success_observed_at: new Date().toISOString() });
    if (t.timeoutTimer) clearTimeout(t.timeoutTimer);
    let outputs: JobOutputAsset[] = harvestOutputRefs(history).map((ref) => ({ ...ref, local_path: "", bytes: 0 }));
    let error: JobError | undefined;
    if (this.deps.autoSave) {
      try {
        outputs = await this.deps.assets.saveOutputs(t.job.batch_id, t.job.idx, history);
      } catch (cause) {
        error = { code: "SAVE_ERROR", message: `Output download failed; get_result retries download only: ${String(cause).slice(0, 200)}` };
      }
    }
    if (this.active(t)) this.settle(t, "succeeded", error, outputs);
  }

  private updateInFlight(t: Tracked, status?: JobRow["status"], error?: JobError): void {
    this.deps.store.transaction(() => {
      if (!this.active(t)) return;
      const current = this.deps.store.getJobById(t.job.id)!;
      const previous = current.error_json ? JSON.parse(current.error_json) as JobError : null;
      const errorJson = error ? JSON.stringify({ ...error, remote_cancel: previous?.remote_cancel ?? error.remote_cancel }) : current.error_json;
      this.deps.store.patchJob(t.job.id, { status: status ?? current.status, error_json: errorJson });
      this.deps.store.patchAttemptStatus(t.job.id, t.job.attempt_no, status ?? current.status, null);
    });
  }

  private settle(t: Tracked, status: JobRow["status"], error?: JobError, outputs?: JobOutputAsset[]): void {
    if (!this.active(t)) return;
    const previous = this.deps.store.getJobById(t.job.id)!.error_json;
    const remote = previous ? (JSON.parse(previous) as JobError).remote_cancel : undefined;
    this.deps.store.settleAttempt(t.job, status, error ? { ...error, remote_cancel: remote } : undefined, outputs);
    this.release(t);
  }

  private release(t: Tracked): void {
    t.settled = true;
    t.unsubscribe();
    if (t.pollTimer) clearInterval(t.pollTimer);
    if (t.timeoutTimer) clearTimeout(t.timeoutTimer);
    this.tracked.delete(t.job.id);
  }
}
