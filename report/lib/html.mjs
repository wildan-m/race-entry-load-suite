// Single-file HTML version of report.md, with the timeline SVG inlined, for readers who do not
// open Markdown. Covers exactly the Markdown that render.mjs writes: headings, paragraphs, lists,
// block quotes, tables, images, bold and inline code.

const CSS = `
  :root { color-scheme: light dark; --surface:#ffffff; --plane:#f9f9f9; --ink:#191919; --ink-2:#666666; --rule:#e7e7e7; --code:#f3f3f3; }
  @media (prefers-color-scheme: dark) { :root { --surface:#191919; --plane:#0b0b0b; --ink:#efefef; --ink-2:#9c9c9c; --rule:#303030; --code:#262626; } }
  body { margin: 0; background: var(--plane); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 32px 24px 48px; background: var(--surface); }
  h1 { font-size: 26px; margin: 0 0 12px; } h2 { font-size: 19px; margin: 32px 0 10px; } h3 { font-size: 16px; margin: 24px 0 8px; }
  p, li { color: var(--ink); } blockquote { margin: 12px 0; padding: 8px 14px; border-left: 3px solid var(--rule); color: var(--ink-2); }
  table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid var(--rule); padding: 6px 8px; text-align: left; } th { color: var(--ink-2); font-weight: 600; }
  code { background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  svg { max-width: 100%; height: auto; }
`;

/**
 * @param {string} markdown report.md
 * @param {Record<string, string>} images image src -> inline SVG markup
 */
export function markdownToHtml(markdown, images = {}) {
  const lines = markdown.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    const image = /^!\[(.*)\]\((.*)\)$/.exec(line);
    if (image) {
      html.push(images[image[2]] ? `<figure role="group" aria-label="${escape(image[1])}">${images[image[2]]}</figure>` : `<img src="${escape(image[2])}" alt="${escape(image[1])}">`);
      i += 1;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      const [head, , ...body] = rows;
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      html.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
      continue;
    }
    if (line.startsWith('> ')) {
      const quoted = [];
      while (i < lines.length && lines[i].startsWith('> ')) quoted.push(lines[i++].slice(2));
      html.push(`<blockquote>${inline(quoted.join(' '))}</blockquote>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|\||- |> |!\[)/.test(lines[i])) paragraph.push(lines[i++]);
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  const title = /^# (.*)$/m.exec(markdown)?.[1] ?? 'Load test report';
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escape(title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n<main>\n${html.join('\n')}\n</main>\n</body>\n</html>\n`;
}

function cells(row) {
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function inline(text) {
  return escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
