import { err, Errors } from "./errors.mjs";

export function validateSpec(spec) {
  if (!spec || typeof spec !== "object") throw err(Errors.ValidationFailed, "spec must be an object");
  if (!spec.task || typeof spec.task !== "string") throw err(Errors.ValidationFailed, "spec.task required");
  if (!spec.prompt || typeof spec.prompt !== "string") throw err(Errors.ValidationFailed, "spec.prompt required");
  if (!spec.entry || typeof spec.entry !== "string") throw err(Errors.ValidationFailed, "spec.entry required");
  if (spec.class && typeof spec.class !== "string") throw err(Errors.ValidationFailed, "spec.class must be a string when present");
  return true;
}

