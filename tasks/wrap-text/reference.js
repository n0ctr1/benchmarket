function wrapText(text, width) {
  if (typeof text !== "string" || !Number.isInteger(width) || width < 1) return null;
  const lines = [];
  for (const para of text.split("\n")) {
    const words = para.split(/[ \t]+/).filter((w) => w !== "");
    let line = "";
    for (let w of words) {
      while (w.length > width) {
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += " " + w;
      else {
        lines.push(line);
        line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}
