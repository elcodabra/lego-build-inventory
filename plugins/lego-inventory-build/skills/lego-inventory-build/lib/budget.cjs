// Spend cap for Meta Model API calls (the hackathon has a fixed budget).
// Before a call we RESERVE its worst-case price (input estimate + full max_output_tokens); after it
// we SETTLE to the real cost from the provider's usage. A call is refused when the reservation
// would cross the total or the daily cap. Amounts are kept in micro-USD integers.
//
// Backends: the hosted server passes a Redis-backed store (api/mcp.mjs); locally a JSON file.
//   META_BUDGET_USD        total cap (default 100: leaves a reserve out of a $150 credit)
//   META_DAILY_BUDGET_USD  per UTC day (default 20)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const usd = (micro) => Math.round(micro) / 1e6;
const micro = (dollars) => Math.ceil(dollars * 1e6);
const limits = () => ({
  total: micro(Number(process.env.META_BUDGET_USD || 100)),
  daily: micro(Number(process.env.META_DAILY_BUDGET_USD || 20)),
});
const today = () => new Date().toISOString().slice(0, 10);

class BudgetError extends Error {
  constructor(which, spent, cap) {
    super(`Meta API budget reached (${which}: $${usd(spent).toFixed(2)} of $${usd(cap).toFixed(2)})`);
    this.code = 'BUDGET_EXCEEDED';
    this.which = which;
  }
}

// Local file store: fine for one process (CLI, local MCP, tests).
function fileStore(file) {
  const f = file || process.env.META_BUDGET_FILE || path.join(process.env.VERCEL ? os.tmpdir() : path.join(os.homedir(), '.lego-build'), 'meta-budget.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { total: 0, days: {}, calls: 0 }; } };
  const write = (s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s)); };
  return {
    async reserve(amount, lim) {
      const s = read();
      const d = today();
      const day = s.days[d] || 0;
      if (s.total + amount > lim.total) return { ok: false, which: 'total', spent: s.total, cap: lim.total };
      if (day + amount > lim.daily) return { ok: false, which: 'daily', spent: day, cap: lim.daily };
      s.total += amount; s.days[d] = day + amount;
      write(s);
      return { ok: true };
    },
    async adjust(delta, calls) {
      const s = read();
      const d = today();
      s.total = Math.max(0, s.total + delta);
      s.days[d] = Math.max(0, (s.days[d] || 0) + delta);
      s.calls = (s.calls || 0) + (calls || 0);
      write(s);
    },
    async status() { const s = read(); return { total: s.total, today: s.days[today()] || 0, calls: s.calls || 0 }; },
  };
}

function budget(store) {
  const st = store || fileStore();
  return {
    // run(worstCaseUsd, fn) -> fn's result; fn returns { costUsd } (null cost = keep the reservation)
    async run(worstUsd, fn) {
      const lim = limits();
      const amount = micro(worstUsd);
      const r = await st.reserve(amount, lim);
      if (!r.ok) throw new BudgetError(r.which, r.spent, r.cap);
      try {
        const out = await fn();
        const real = out && Number.isFinite(out.costUsd) ? micro(out.costUsd) : amount;
        await st.adjust(real - amount, 1);
        return out;
      } catch (e) {
        // a failed call may still be billed when the provider answered: settle to its real cost
        const real = e && Number.isFinite(e.costUsd) ? micro(e.costUsd) : 0;
        await st.adjust(real - amount, real ? 1 : 0);
        throw e;
      }
    },
    async status() {
      const s = await st.status();
      const lim = limits();
      return { spentUsd: usd(s.total), todayUsd: usd(s.today), calls: s.calls, capUsd: usd(lim.total), dailyCapUsd: usd(lim.daily) };
    },
  };
}

module.exports = { budget, fileStore, BudgetError, limits, micro, usd };
