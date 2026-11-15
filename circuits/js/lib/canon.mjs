export function canonBodyRelaxed(body) {
  let lines = body.replace(/\r?\n/g, '\r\n').split('\r\n');
  lines = lines.map((l) => l.replace(/[ \t]+/g, ' ').replace(/ +$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}
export function canonHeaderRelaxed(name, value) {
  return name.toLowerCase().trim() + ':' + value.replace(/\r?\n[ \t]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
}
