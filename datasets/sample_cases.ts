/**
 * Sample bug dataset for the PoC.
 *
 * Each case has:
 *  - buggyCode: a small but real bug
 *  - symptom: the observable failure
 *  - referenceFix: ground truth, used only for the eval report
 *
 * Cases are intentionally tiny (one function) so that the LLM can produce
 * a full-file patch in a single shot. Scaling to multi-file repos is a
 * matter of switching to tree-sitter-anchored patches, not architecture.
 */
import type { BugCase } from "../src/types/engine.js";

export const SAMPLE_CASES: BugCase[] = [
  {
    id: "off-by-one",
    language: "python",
    description: "sum_range should sum integers from a to b inclusive, but misses the last element.",
    specification:
      "`sum_range(a, b)` returns the sum of all integers from `a` to `b`, inclusive. " +
      "For example, sum_range(1, 3) should return 6 (1+2+3).",
    buggyCode: `def sum_range(a, b):
    total = 0
    for i in range(a, b):
        total += i
    return total
`,
    symptom:
      "Test failure: assert sum_range(1, 3) == 6, but got 3 (only 1+2 was summed, 3 was missed).",
    referenceFix: `def sum_range(a, b):
    total = 0
    for i in range(a, b + 1):
        total += i
    return total
`,
  },
  {
    id: "mutable-default-arg",
    language: "python",
    description: "append_item reuses the same list across calls because of a mutable default argument.",
    specification:
      "`append_item(item, items=None)` returns a new list with `item` appended. " +
      "If `items` is None, start from an empty list. The function must NOT mutate its input " +
      "and must NOT share state across calls.",
    buggyCode: `def append_item(item, items=[]):
    items.append(item)
    return items
`,
    symptom:
      "Test failure: first call append_item(1) returns [1], second call append_item(2) returns [1, 2] instead of [2].",
    referenceFix: `def append_item(item, items=None):
    if items is None:
        items = []
    items = list(items)
    items.append(item)
    return items
`,
  },
  {
    id: "integer-division",
    language: "python",
    description: "average should return a float, but uses integer division.",
    specification:
      "`average(numbers)` returns the arithmetic mean of a non-empty list of numbers as a float. " +
      "For example, average([1, 2, 3, 4]) should return 2.5.",
    buggyCode: `def average(numbers):
    return sum(numbers) / len(numbers) // 1
`,
    symptom:
      "Test failure: assert average([1, 2, 3, 4]) == 2.5, but got 2.0.",
    referenceFix: `def average(numbers):
    return sum(numbers) / len(numbers)
`,
  },
  {
    id: "wrong-comparison-op",
    language: "python",
    description: "is_adult returns True for age 18 due to a strict-greater-than instead of greater-equal.",
    specification:
      "`is_adult(age)` returns True if and only if `age` is 18 or above. " +
      "In most jurisdictions, 18 is the legal adulthood threshold.",
    buggyCode: `def is_adult(age):
    return age > 18
`,
    symptom:
      "Test failure: assert is_adult(18) is True, but got False.",
    referenceFix: `def is_adult(age):
    return age >= 18
`,
  },
];
