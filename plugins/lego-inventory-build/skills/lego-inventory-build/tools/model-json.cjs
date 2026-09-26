// Print a model as JSON, e.g. to start a new model from an example.
//   node tools/model-json.cjs cat > models/my-cat.json
const core = require('../lib/core.cjs');
try {
  const m = core.loadModel(process.argv[2] || 'cat');
  const steps = m.steps.map((st) => '  [\n' + st.map((s) => '    ' + JSON.stringify(s)).join(',\n') + '\n  ]').join(',\n');
  console.log(`{\n "title": ${JSON.stringify(m.title)}, "theta": ${m.theta}, "phi": ${m.phi},\n "steps": [\n${steps}\n ]\n}`);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
