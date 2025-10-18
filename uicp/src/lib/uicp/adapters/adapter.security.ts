import { checkPermission as checkPermissionImpl } from "../../permissions/PermissionManager";
import { sanitizeHtmlStrict as sanitizeHtmlStrictImpl } from "../../sanitizer";

export const checkPermission = checkPermissionImpl;
export const sanitizeHtmlStrict = sanitizeHtmlStrictImpl;

export const escapeHtml = (unsafe: string): string =>
  unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
