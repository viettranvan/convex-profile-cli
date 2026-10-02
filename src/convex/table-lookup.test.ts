import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDataTableRequest,
  replaceDataTableName,
  resolveTableName,
  tableNameDistance,
} from "./table-lookup.js";

test("table operand parsing skips option values and captures component", () => {
  const args = ["--limit", "10", "--order=desc", "--component", "workflow", "trimesters", "--format", "json"];
  const request = parseDataTableRequest(args);
  assert.deepEqual(request, {
    tableName: "trimesters",
    argumentIndex: 5,
    component: "workflow",
  });
  assert.deepEqual(
    replaceDataTableName(args, request!, "terms"),
    ["--limit", "10", "--order=desc", "--component", "workflow", "terms", "--format", "json"],
  );
  assert.deepEqual(
    parseDataTableRequest(["trimesters", "--component", "workflow", "--limit", "5"]),
    { tableName: "trimesters", argumentIndex: 0, component: "workflow" },
  );
});

test("table name resolution accepts exact names and corrects one unique typo", () => {
  assert.deepEqual(resolveTableName("trimesters", ["academicYears", "trimesters"]), {
    kind: "exact",
    tableName: "trimesters",
  });
  assert.deepEqual(resolveTableName("trimester", ["academicYears", "trimesters"]), {
    kind: "corrected",
    tableName: "trimesters",
    distance: 1,
  });
  assert.deepEqual(resolveTableName("userS", ["users"]), {
    kind: "corrected",
    tableName: "users",
    distance: 0,
  });
});

test("ambiguous and distant table names are never silently corrected", () => {
  assert.deepEqual(resolveTableName("user", ["users", "used"]), {
    kind: "ambiguous",
    suggestions: ["used", "users"],
  });
  assert.deepEqual(resolveTableName("elephant", ["terms", "users"]), {
    kind: "missing",
    suggestions: [],
  });
});

test("adjacent transposition counts as one typo", () => {
  assert.equal(tableNameDistance("trimestres", "trimesters"), 1);
});
