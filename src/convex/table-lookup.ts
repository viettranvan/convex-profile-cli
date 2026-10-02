export type DataTableRequest = {
  tableName: string;
  argumentIndex: number;
  component?: string;
};

export type TableNameResolution =
  | { kind: "exact"; tableName: string }
  | { kind: "corrected"; tableName: string; distance: number }
  | { kind: "ambiguous"; suggestions: string[] }
  | { kind: "missing"; suggestions: string[] };

const OPTIONS_WITH_VALUE = new Set([
  "--limit",
  "--order",
  "--component",
  "--format",
  "--deployment",
  "--url",
  "--admin-key",
  "--env-file",
]);

/** Extract the table operand without mistaking values such as `--limit 10` for it. */
export function parseDataTableRequest(args: string[]): DataTableRequest | undefined {
  let component: string | undefined;
  let tableName: string | undefined;
  let argumentIndex: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      if (!tableName && args[index + 1]) {
        tableName = args[index + 1];
        argumentIndex = index + 1;
      }
      break;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      const option = arg.slice(0, equalsIndex);
      if (option === "--component") component = arg.slice(equalsIndex + 1);
      if (OPTIONS_WITH_VALUE.has(option)) continue;
    }

    if (OPTIONS_WITH_VALUE.has(arg)) {
      const value = args[index + 1];
      if (arg === "--component") component = value;
      index += value === undefined ? 0 : 1;
      continue;
    }

    if (arg.startsWith("-")) continue;
    if (!tableName) {
      tableName = arg;
      argumentIndex = index;
    }
  }
  return tableName && argumentIndex !== undefined
    ? { tableName, argumentIndex, component }
    : undefined;
}

export function replaceDataTableName(
  args: string[],
  request: DataTableRequest,
  tableName: string,
): string[] {
  const replaced = [...args];
  replaced[request.argumentIndex] = tableName;
  return replaced;
}

function normalizeTableName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Damerau-Levenshtein distance, counting adjacent transpositions as one typo. */
export function tableNameDistance(left: string, right: string): number {
  const a = Array.from(normalizeTableName(left));
  const b = Array.from(normalizeTableName(right));
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array<number>(b.length + 1).fill(0),
  );

  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
}

export function resolveTableName(
  requestedName: string,
  availableNames: string[],
): TableNameResolution {
  if (availableNames.includes(requestedName)) {
    return { kind: "exact", tableName: requestedName };
  }

  const normalizedRequest = normalizeTableName(requestedName);
  const caseMatches = availableNames.filter(
    (name) => normalizeTableName(name) === normalizedRequest,
  );
  if (caseMatches.length === 1) {
    return { kind: "corrected", tableName: caseMatches[0], distance: 0 };
  }
  if (caseMatches.length > 1) {
    return { kind: "ambiguous", suggestions: caseMatches.slice(0, 3) };
  }

  const maxCorrectionDistance = Math.max(
    1,
    Math.min(2, Math.floor(Array.from(normalizedRequest).length * 0.2)),
  );
  const ranked = availableNames
    .map((name) => ({ name, distance: tableNameDistance(requestedName, name) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const close = ranked.filter(({ distance }) => distance <= maxCorrectionDistance);
  if (close.length === 1) {
    return { kind: "corrected", tableName: close[0].name, distance: close[0].distance };
  }
  if (close.length > 1) {
    return { kind: "ambiguous", suggestions: close.slice(0, 3).map(({ name }) => name) };
  }

  const suggestionDistance = Math.max(2, Math.floor(Array.from(normalizedRequest).length * 0.3));
  return {
    kind: "missing",
    suggestions: ranked
      .filter(({ distance }) => distance <= suggestionDistance)
      .slice(0, 3)
      .map(({ name }) => name),
  };
}
