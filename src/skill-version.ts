export function parseSkillVersion(value: string): [number, number, number] {
  if (!/^\d+(?:\.\d+){0,2}$/.test(value)) {
    throw new TypeError("Skill versions must be numeric dotted values such as 1.1.0");
  }
  const parts = value.split(".").map(Number).concat([0, 0]).slice(0, 3);
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function assertSkillVersion(value: string): void {
  parseSkillVersion(value);
}

export function assertNextSkillVersion(current: string, next: string): void {
  const oldVersion = parseSkillVersion(current);
  const newVersion = parseSkillVersion(next);
  for (let index = 0; index < newVersion.length; index += 1) {
    if (newVersion[index]! > oldVersion[index]!) return;
    if (newVersion[index]! < oldVersion[index]!) break;
  }
  throw new Error(`Skill revision must advance version beyond ${current}`);
}
