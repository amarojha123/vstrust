// BSON encodes Unicode scalar values. Reject lone surrogates before computing
// immutable content hashes so serialization cannot silently change stored text.
export function isWellFormedText(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}
