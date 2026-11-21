const express = require('express');
const { MongoClient } = require('mongodb');
const { trace, metrics } = require('@opentelemetry/api');
const sdk = require('./tracing');

const app = express();
app.use(express.json());
const client = new MongoClient('mongodb://127.0.0.1:27017/');
const todos = client.db('todo').collection('todos');
const requestCount = metrics.getMeter('todo-app').createCounter('todo.requests', {
  description: 'Completed HTTP requests grouped by route and status',
  unit: '{request}',
});

// Keep the request log and trace joinable, even after the response finishes.
app.use((req, res, next) => {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  if (traceId) res.set('X-Trace-Id', traceId);
  res.on('finish', () => {
    const route = req.route?.path ?? 'unmatched';
    requestCount.add(1, { route, status: res.statusCode });
    console.log(JSON.stringify({
      time: new Date().toISOString(), event: 'request.completed',
      method: req.method, route, status: res.statusCode, traceId,
    }));
  });
  next();
});

app.get('/todo', async (req, res) => {
  res.send(await todos.find({}).toArray());
});

app.get('/todo/:id', async (req, res) => {
  const todo = await todos.findOne({ id: req.params.id });
  if (!todo) return res.status(404).json({ error: 'Todo not found' });
  res.send(todo);
});

async function startServer() {
  await client.connect();
  const seed = [
    { id: '1', title: 'Buy groceries' },
    { id: '2', title: 'Install Aspecto' },
    { id: '3', title: 'buy my own name domain' },
  ];
  for (const todo of seed) {
    await todos.updateOne({ id: todo.id }, { $setOnInsert: todo }, { upsert: true });
  }
  const server = app.listen(3000, '127.0.0.1', () => {
    console.log('Example app listening on port 3000');
  });
  const shutdown = () => server.close(async () => {
    await client.close();
    await sdk.shutdown();
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

startServer().catch(async error => {
  console.error(error.message);
  await client.close();
  await sdk.shutdown();
  process.exitCode = 1;
});
