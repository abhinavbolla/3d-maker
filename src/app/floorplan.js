// The floor plan sheet, made the way the mechanical drawing is (sheet.js):
// the same title block fields, remembered the same way, and the same
// drawing number for the model. Only the sheet differs, so this hands
// makeDrawing the floor-plan exporter in place of the drawing one, and
// leaves out what does not apply to a plan (the projection).
import { makeDrawing } from "./sheet.js";

export async function makeFloorPlan({ store, kernel }, args = {}) {
  if (!store.state.result?.building) throw new Error("This model has no building to draw a plan of. A floor plan is made from outerWalls(), wall(), door(), window() and room() in the script.");
  const { projection, axis, offset, ...fields } = args;
  const plan = { exportDrawing: (_parts, { info }) => kernel.exportFloorPlan(store.state.result, { info }) };
  const { result, keep } = await makeDrawing({ store, kernel: plan }, fields);
  const { projection: _p, ...sheet } = result.sheet;
  const line = result.line.replace(/^Drawing (\S+( rev\. \S+)?), (first|third) angle( \(from your region\))?,/, "Floor plan $1,");
  return { result: { ...result, sheet, line }, keep };
}
