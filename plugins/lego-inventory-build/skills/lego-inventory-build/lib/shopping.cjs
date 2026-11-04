// Shopping list: the parts an idea is missing, as a BrickLink wanted-list XML (the format BrickLink's
// "Upload" > "Wanted List" accepts). Colour ids from src/lego.js (BrickLink numbering).
'use strict';
const core = require('./core.cjs');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// BrickLink item number: drop our internal suffixes for printed/assembled variants we do not use
const blId = (id) => String(id);

function wantedListXml(items) {
  const rows = items.filter((x) => x.qty > 0).map((x) => {
    const c = core.LEGO.COLORS[x.color];
    return `  <ITEM>\n    <ITEMTYPE>P</ITEMTYPE>\n    <ITEMID>${esc(blId(x.id))}</ITEMID>\n${c && c.bl != null ? `    <COLOR>${c.bl}</COLOR>\n` : ''}    <MINQTY>${Number(x.qty)}</MINQTY>\n  </ITEM>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<INVENTORY>\n${rows.join('\n')}\n</INVENTORY>\n`;
}

module.exports = { wantedListXml };
