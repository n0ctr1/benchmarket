function parseCSV(text) {
  if (typeof text !== "string") return null;
  if (text === "") return [];
  const records = [];
  let record = [];
  let field = "";
  let i = 0;
  let endedWithBreak = false;
  while (i < text.length) {
    endedWithBreak = false;
    if (text[i] === '"') {
      if (field !== "") return null;
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            closed = true;
            i++;
            break;
          }
        } else {
          field += text[i++];
        }
      }
      if (!closed) return null;
      const next = text[i];
      if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") return null;
      continue;
    }
    const c = text[i];
    if (c === ",") {
      record.push(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r") {
        if (text[i + 1] !== "\n") return null;
        i++;
      }
      i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      endedWithBreak = true;
    } else {
      // A quote may only open a field; a quote here sits inside an unquoted field.
      field += c;
      i++;
      if (text[i] === '"') return null;
    }
  }
  if (!endedWithBreak) {
    record.push(field);
    records.push(record);
  }
  return records;
}
