import base64
from contextlib import redirect_stderr
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import comfy_audit


class AuditTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        Path('.analysis').mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir='.analysis')
        self.log = Path(self.directory.name).resolve() / 'audit.jsonl'
        self.environment = patch.dict(os.environ, {'COMFY_BENCH_AUDIT_LOG': str(self.log)})
        self.environment.start()
        self.calls = []
        calls = self.calls

        class Server:
            def __init__(self):
                self.app = web.Application()
                self.app.router.add_post('/prompt', self.prompt)
                self.app.router.add_post('/api/prompt', self.prompt)
                self.app.router.add_get('/other', self.other)
                self.client_id = None

            async def prompt(self, request):
                calls.append(('prompt', await request.read()))
                return web.Response(status=201, body=b'{"prompt_id":"p1"}', content_type='application/json')

            async def other(self, request):
                return web.Response(text='ok')

            def send_sync(self, event, data, sid=None):
                calls.append(('send_sync', event, data, sid))
                return 'send-result'

        class Executor:
            def __init__(self, server):
                self.server = server
                self.status_messages = []

            def add_message(self, event, data, broadcast):
                result = {**data, 'timestamp': 123}
                self.status_messages.append((event, result))
                if self.server.client_id is not None or broadcast:
                    self.server.send_sync(event, result, self.server.client_id)
                return 'original-result'

        self.state = comfy_audit.install(Server, Executor)
        self.server = Server()
        self.executor = Executor(self.server)
        self.client = TestClient(TestServer(self.server.app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.environment.stop()
        self.directory.cleanup()

    async def test_both_routes_and_clientless_execution(self):
        payload = b'{"prompt":{"id":1}}'
        for route in ('/prompt', '/api/prompt'):
            async with self.client.post(route, data=payload) as response:
                self.assertEqual(response.status, 201)
                self.assertEqual(await response.read(), b'{"prompt_id":"p1"}')
        async with self.client.get('/other') as response:
            self.assertEqual(await response.text(), 'ok')
        data = {'prompt_id': 'p1'}
        self.assertEqual(self.executor.add_message('execution_start', data, broadcast=False), 'original-result')
        self.assertEqual(self.executor.status_messages, [('execution_start', {'prompt_id':'p1', 'timestamp':123})])
        self.assertEqual(data, {'prompt_id': 'p1'})
        rows = [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(rows), 5)
        self.assertEqual([x['kind'] for x in rows], ['prompt_request','prompt_response','prompt_request','prompt_response','execution_event'])
        for i in (0, 2):
            self.assertEqual(base64.b64decode(rows[i]['request_body_base64']), payload)
            self.assertEqual(base64.b64decode(rows[i+1]['response_body_base64']), b'{"prompt_id":"p1"}')
            self.assertEqual(rows[i]['request_id'], rows[i+1]['request_id'])
            self.assertEqual(rows[i+1]['status'], 201)
        self.assertEqual((rows[4]['event'], rows[4]['data'], rows[4]['sid']), ('execution_start', {'prompt_id':'p1','timestamp':123}, None))
        self.assertEqual(self.calls, [('prompt', payload), ('prompt', payload)])
        self.assertFalse(self.state['failed'])

    async def test_client_events_are_not_double_counted(self):
        self.server.client_id = 'client'
        self.assertEqual(self.executor.add_message('execution_success', {'prompt_id':'p1'}, False), 'original-result')
        rows = [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['sid'], 'client')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0], 'send_sync')

    async def test_log_failure_invalidates_audit_without_changing_response(self):
        self.log.mkdir()
        output = io.StringIO()
        with redirect_stderr(output):
            async with self.client.post('/prompt', data=b'{}') as response:
                self.assertEqual(response.status, 201)
                self.assertEqual(await response.read(), b'{"prompt_id":"p1"}')
        self.assertTrue(self.state['failed'])
        self.assertIn('COMFY_BENCH_AUDIT_FAILURE', output.getvalue())
        self.assertEqual(self.calls, [('prompt', b'{}')])


if __name__ == '__main__':
    unittest.main()
