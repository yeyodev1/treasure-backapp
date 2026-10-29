import mongoose from "mongoose";

const counters = () => mongoose.connection.collection<{ _id: string; n: number }>("codecounters");

/**
 * Código correlativo atómico (RQ-001, CP-001…). Dos tablets que crean al
 * mismo tiempo nunca reciben el mismo código.
 */
export async function nextCode(prefix: string, seedFrom = 0): Promise<string> {
  if (seedFrom > 0) {
    await counters().updateOne({ _id: prefix }, { $max: { n: seedFrom } }, { upsert: true });
  }
  const doc = await counters().findOneAndUpdate(
    { _id: prefix },
    { $inc: { n: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return `${prefix}-${String(doc?.n ?? 1).padStart(3, "0")}`;
}
