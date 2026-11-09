import path from "node:path";
import { stat } from "node:fs/promises";
import type { AssetManager } from "../assets/asset-manager.js";
import { atomicWrite, isFileError, localFileSize, readLocalText } from "../assets/local-files.js";
import { jailedJoin, PathJailError, safeFileName } from "../assets/path-jail.js";
import { ComfyLightError } from "../../shared/errors.js";
import { type BatchStore, type JobOutputAsset, type JobRow, parseBatchOptions } from "./store.js";
import type { WorkflowRegistry } from "../workflow/registry.js";

interface DeliveryError {
  code: string;
  message: string;
}
export interface IndexOutput {
  kind: JobOutputAsset["kind"];
  filename: string;
  local_path: string | null;
  bytes: number | null;
  availability: "available" | "not_downloaded" | "download_failed" | "unsafe_path";
  error?: DeliveryError;
}

export interface BatchResultIndex {
  batch_id: string;
  status: string;
  complete: boolean;
  total: number;
  succeeded: number;
  failed: number;
  invalid: number;
  unresolved: number;
  unavailable_outputs: number;
  index_path: string;
  updated_at: string;
}

interface CollectedOutputs {
  job: JobRow;
  assets: JobOutputAsset[];
  outputs: IndexOutput[];
  failure?: unknown;
}

/** Result delivery only: never starts the scheduler, queries history, or submits work. */
export class ResultDelivery {
  private readonly collecting = new Map<string, { download: boolean; pending: Promise<CollectedOutputs> }>();
  private readonly indexing = new Map<string, Promise<BatchResultIndex>>();

  constructor(
    private readonly store: BatchStore,
    private readonly assets: AssetManager,
    private readonly outputDir: string,
    private readonly registry: WorkflowRegistry
  ) {}

  collect(job: JobRow, download: boolean): Promise<CollectedOutputs> {
    const active = this.collecting.get(job.id);
    // A different download preference must run after the current collection.
    if (active) return active.download === download ? active.pending : active.pending.then(() => this.collect(job, download));
    const pending = this.collectOutputs(job, download).finally(() => this.collecting.delete(job.id));
    this.collecting.set(job.id, { download, pending });
    return pending;
  }

  index(batchId: string, download = true): Promise<BatchResultIndex> {
    const key = `${batchId}:${download}`;
    const active = this.indexing.get(key);
    if (active) return active;
    // Serialize different preferences too: both replace the same index file.
    const other = this.indexing.get(`${batchId}:${!download}`);
    if (other) return other.then(() => this.index(batchId, download));
    const pending = this.writeIndex(batchId, download).finally(() => this.indexing.delete(key));
    this.indexing.set(key, pending);
    return pending;
  }

  private async collectOutputs(job: JobRow, download: boolean): Promise<CollectedOutputs> {
    const current = this.store.getJobById(job.id)!;
    const assets = JSON.parse(current.outputs_json ?? "[]") as JobOutputAsset[];
    const outputs: IndexOutput[] = [];
    let failure: unknown;
    const usedNames = new Set<string>();
    for (const [i, asset] of assets.entries()) {
      let target: string;
      let size: number | null;
      try {
        target = this.assets.outputPath(job.batch_id, job.idx, asset.filename, usedNames);
        if (asset.local_path && path.resolve(asset.local_path) !== target) throw new PathJailError("stored output path does not match its job");
        size = await localFileSize(this.outputDir, target);
      } catch (error) {
        if (!(error instanceof PathJailError) && !isFileError(error)) throw error;
        failure ??= error;
        outputs.push({ kind: asset.kind, filename: asset.filename, local_path: null, bytes: null,
          availability: "unsafe_path", error: { code: "OUTPUT_UNAVAILABLE", message: "Output path is unsafe or unreadable" } });
        continue;
      }
      if (size !== null) {
        outputs.push({ kind: asset.kind, filename: asset.filename, local_path: target, bytes: size, availability: "available" });
        if (current.status === "succeeded" && (asset.local_path !== target || asset.bytes !== size)) {
          assets[i] = { ...asset, local_path: target, bytes: size };
          this.store.patchJob(job.id, { outputs_json: JSON.stringify(assets) });
        }
        continue;
      }
      if (!download || current.status !== "succeeded") {
        outputs.push({ kind: asset.kind, filename: asset.filename, local_path: null, bytes: null, availability: "not_downloaded" });
        continue;
      }
      let saved: JobOutputAsset;
      try {
        saved = await this.assets.downloadRef(asset, target);
      } catch (error) {
        // This boundary converts download/filesystem failures into retryable delivery metadata.
        failure ??= error;
        outputs.push({ kind: asset.kind, filename: asset.filename, local_path: null, bytes: null,
          availability: "download_failed", error: { code: "DOWNLOAD_FAILED", message: "Output download failed; retry get_result" } });
        continue;
      }
      assets[i] = saved;
      this.store.patchJob(job.id, { outputs_json: JSON.stringify(assets) });
      outputs.push({ kind: saved.kind, filename: saved.filename, local_path: saved.local_path, bytes: saved.bytes, availability: "available" });
    }
    return { job: current, assets, outputs, failure };
  }

  private async writeIndex(batchId: string, download: boolean): Promise<BatchResultIndex> {
    const batch = this.store.getBatch(batchId);
    if (!batch) throw new ComfyLightError("NOT_FOUND", "Batch does not exist");
    safeFileName(batchId);
    const indexPath = jailedJoin(this.outputDir, batchId, "results.jsonl");
    const jobs = this.store.listJobs(batchId, { limit: -1, offset: 0 });
    const options = parseBatchOptions(batch.options_json);
    const workflow = this.registry.get(batch.workflow);
    const seedNames = workflow && workflow.fingerprints.manifestFingerprint === batch.manifest_fingerprint &&
      workflow.fingerprints.graphFingerprint === batch.graph_fingerprint
      ? workflow.manifest.params.filter((param) => param.special === "seed" || param.name === "seed").map((param) => param.name)
      : ["seed"];
    let succeeded = 0;
    let failed = 0;
    let invalid = 0;
    let unresolved = 0;
    let unavailable = 0;
    const records = [];
    for (const snapshot of jobs) {
      const collected = await this.collect(snapshot, download);
      // Status, seed and references belong to the same per-job snapshot. A concurrent
      // tracker settlement is visible on the next request, never as a partial result.
      const job = collected.job;
      const retryPending = this.store.retryEligibility(job, options);
      if (retryPending) unresolved++;
      else if (job.status === "succeeded") succeeded++;
      else if (job.status === "invalid") invalid++;
      else if (["failed", "timeout", "cancelled"].includes(job.status)) failed++;
      else unresolved++;
      const resolved = JSON.parse(job.resolved_json ?? "null") as Record<string, unknown> | null;
      const seeds = Object.fromEntries(
        seedNames.filter((name) => typeof resolved?.[name] === "number").map((name) => [name, resolved![name]])
      );
      const storedError = JSON.parse(job.error_json ?? "null") as DeliveryError | null;
      const error = storedError ? { code: String(storedError.code).slice(0, 80), message: String(storedError.message).slice(0, 200) }
        : ["invalid", "submission_unknown", "paused", "failed", "timeout", "cancelled"].includes(job.status)
          ? { code: job.status.toUpperCase(), message: `Job is ${job.status}` } : null;
      unavailable += collected.outputs.filter((o) => o.availability !== "available").length;
      const seed = seeds.seed ?? (seedNames.length === 1 ? seeds[seedNames[0]!] : null) ?? null;
      records.push({ index: job.idx, label: job.label, status: job.status, seed,
        ...(seedNames.some((name) => name !== "seed") ? { seeds } : {}),
        outputs: collected.outputs, error, ...(retryPending ? { retry_pending: true } : {}) });
    }
    const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const previous = await readLocalText(this.outputDir, indexPath);
    if (previous !== content) await atomicWrite(this.outputDir, indexPath, content);
    // mtime describes the actual snapshot, remaining stable when content is unchanged.
    const updatedAt = (await stat(indexPath)).mtime.toISOString();
    const complete = unresolved === 0 && jobs.length === batch.total;
    const status = complete ? (succeeded === jobs.length ? "completed" : succeeded ? "partial" : "failed") : "running";
    return {
      batch_id: batchId,
      status,
      complete,
      total: jobs.length,
      succeeded,
      failed,
      invalid,
      unresolved,
      unavailable_outputs: unavailable,
      index_path: indexPath,
      updated_at: updatedAt
    };
  }
}
