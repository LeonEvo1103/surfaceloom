export const approvalPage = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Reference agent approval</title>
<body><main>
<h1>Reference agent approval</h1>
<p>This local fixture requests one deterministic append-note tool operation.</p>
<button data-testid="run.start">Start run</button>
<p data-testid="run.id"></p><p data-testid="run.status" role="status">idle</p>
<script type="application/json" data-testid="run.snapshot">{}</script>
<section data-testid="approval.gate" hidden>
<h2>Allow append-note?</h2>
<button data-testid="approval.approve">Approve</button>
<button data-testid="approval.deny">Deny</button>
</section><p data-testid="run.error" role="alert"></p>
</main><script type="module">
const byId = (id) => document.querySelector('[data-testid="' + id + '"]');
let runId = new URL(location.href).searchParams.get('run');
let generation = 0;
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error.message);
  return result;
}
function render(run, token) {
  if (token !== generation || (runId !== null && runId !== run.runId)) return false;
  runId = run.runId;
  byId('run.id').textContent = runId;
  byId('run.status').textContent = run.status;
  byId('approval.gate').hidden = run.status !== 'awaiting-approval';
  byId('run.snapshot').textContent = JSON.stringify({
    runId: run.runId, callId: run.callId, status: run.status, approvalRequested: true,
  });
  history.replaceState(null, '', '?run=' + encodeURIComponent(runId));
  return true;
}
const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
async function poll(expectedRunId, token) {
  while (token === generation && runId === expectedRunId) {
    try {
      const run = await request('/api/runs/' + encodeURIComponent(expectedRunId));
      if (token !== generation || run.runId !== expectedRunId || !render(run, token)) return;
      if (run.ended || run.status === 'failed') return;
      await delay();
    } catch (error) {
      if (token === generation) byId('run.error').textContent = error.message;
      return;
    }
  }
}
async function act(action, expectedRunId = null) {
  const token = ++generation;
  runId = expectedRunId;
  byId('run.error').textContent = '';
  try {
    const run = await action();
    if (token !== generation || (expectedRunId !== null && run.runId !== expectedRunId)) return;
    runId = run.runId;
    render(run, token);
    if (!run.ended && run.status !== 'failed') void poll(run.runId, token);
  } catch (error) {
    if (token === generation) byId('run.error').textContent = error.message;
  }
}
byId('run.start').addEventListener('click', () => act(() => request('/api/runs', {})));
for (const decision of ['approve', 'deny']) {
  byId('approval.' + decision).addEventListener('click', () => {
    const expectedRunId = runId;
    void act(() => request('/api/runs/' + encodeURIComponent(expectedRunId) + '/decision',
      { decision }), expectedRunId);
  });
}
if (runId) {
  const expectedRunId = runId;
  await act(() => request('/api/runs/' + encodeURIComponent(expectedRunId)), expectedRunId);
}
</script></body></html>`;
