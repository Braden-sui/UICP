import { validateBatch, type Batch, type Envelope } from '../uicp/schemas';
import { parseUtterance } from './parse';
import { toOp } from './map';

// WHY: Provide a shared WIL → Batch converter for legacy fallbacks (planner/actor text paths, stream aggregator).
// INVARIANT: Returns null when any line fails to parse or validation rejects the batch.
export function parseWilToBatch(input: string): Batch | null {
  const lines = (input ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^nop:/i.test(line));

  if (lines.length === 0) {
    return null;
  }

  const envelopes: Envelope[] = [];

  for (const line of lines) {
    const parsed = parseUtterance(line);
    if (!parsed) {
      return null;
    }
    try {
      const op = toOp(parsed) as Envelope;
      envelopes.push(op);
    } catch {
      return null;
    }
  }

  try {
    return validateBatch(envelopes);
  } catch {
    return null;
  }
}

