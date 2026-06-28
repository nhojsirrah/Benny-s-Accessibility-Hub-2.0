/**
 * Manifest validator — load-time app-contract gate for Benny's Hub.
 *
 * Validates a single manifest entry (or an array of entries) from
 * games.json / tools.json against manifest.schema.json. The validator is a
 * tiny, dependency-free interpreter for the subset of JSON Schema draft-07 the
 * manifest schema uses: type, required, properties, items, enum, anyOf, and
 * additionalProperties (boolean form). It is intentionally hand-rolled so the
 * hub can gate manifests without pulling in a JSON Schema runtime.
 *
 * Public API (both browser and Node):
 *   validate(entry)        -> { valid: boolean, errors: string[] }
 *   validateAll(entries)   -> { valid: boolean, errors: string[] }
 *
 * validateAll accepts either a raw array of entries or a manifest wrapper
 * object ({ games: [...] } / { tools: [...] }). Errors are prefixed with the
 * offending entry's index/id so reconciliation findings are greppable.
 */
(function (root) {
  "use strict";

  // The schema is inlined here (structurally mirroring manifest.schema.json,
  // minus the descriptive annotations) so the validator works in the browser
  // without a fetch and in Node without resolving a relative JSON path at call
  // time. The accompanying test asserts the validation-bearing parts of this
  // copy (required, properties, enums, anyOf) stay in sync with the on-disk
  // schema file.
  var SCHEMA = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Benny's Hub App Manifest Entry",
    type: "object",
    additionalProperties: false,
    required: ["id", "title", "description", "image", "genres"],
    anyOf: [{ required: ["path"] }, { required: ["launchExternal"] }],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      image: { type: "string" },
      genres: { type: "array", items: { type: "string" } },
      path: { type: "string" },
      launchExternal: { type: "string" },
      needsServer: { type: "boolean" },
      launchWindow: { type: "boolean" },
      type: { type: "string", enum: ["game", "tool"] },
      entry: { type: "string" },
      capabilities: {
        type: "object",
        additionalProperties: false,
        properties: {
          needsElectron: { type: "boolean" },
          usesPhysics: { type: "boolean" },
          twoPlayer: { type: "boolean" },
        },
      },
      controls: { type: "string" },
      settingsSchema: { type: "object" },
      version: { type: "string" },
    },
  };

  function typeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  function matchesType(value, expected) {
    switch (expected) {
      case "object":
        return typeOf(value) === "object";
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "boolean":
        return typeof value === "boolean";
      case "number":
        return typeof value === "number";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  }

  // Validate `value` against `schema`, pushing human-readable messages onto
  // `errors`. `path` is a dotted breadcrumb for nested fields.
  function validateNode(value, schema, path, errors) {
    if (schema.type && !matchesType(value, schema.type)) {
      errors.push(
        at(path) + "expected type " + schema.type + " but got " + typeOf(value),
      );
      // Type is wrong; deeper checks would be noise.
      return;
    }

    if (Array.isArray(schema.required) && typeOf(value) === "object") {
      schema.required.forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(at(path) + "missing required field '" + key + "'");
        }
      });
    }

    if (Array.isArray(schema.anyOf)) {
      var passed = schema.anyOf.some(function (sub) {
        var subErrors = [];
        validateNode(value, sub, path, subErrors);
        return subErrors.length === 0;
      });
      if (!passed) {
        errors.push(
          at(path) +
            "did not satisfy any required alternative (" +
            describeAnyOf(schema.anyOf) +
            ")",
        );
      }
    }

    if (schema.properties && typeOf(value) === "object") {
      Object.keys(schema.properties).forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          validateNode(
            value[key],
            schema.properties[key],
            path ? path + "." + key : key,
            errors,
          );
        }
      });
    }

    if (schema.additionalProperties === false && typeOf(value) === "object") {
      var allowed = schema.properties ? Object.keys(schema.properties) : [];
      Object.keys(value).forEach(function (key) {
        if (allowed.indexOf(key) === -1) {
          errors.push(at(path) + "unknown field '" + key + "'");
        }
      });
    }

    if (schema.items && Array.isArray(value)) {
      value.forEach(function (item, i) {
        validateNode(item, schema.items, path + "[" + i + "]", errors);
      });
    }

    if (Array.isArray(schema.enum)) {
      var ok = schema.enum.some(function (allowedValue) {
        return allowedValue === value;
      });
      if (!ok) {
        errors.push(
          at(path) +
            "value '" +
            String(value) +
            "' is not one of [" +
            schema.enum.join(", ") +
            "]",
        );
      }
    }
  }

  function at(path) {
    return path ? path + ": " : "";
  }

  function describeAnyOf(anyOf) {
    return anyOf
      .map(function (sub) {
        if (Array.isArray(sub.required)) {
          return "requires " + sub.required.join("+");
        }
        return "alternative";
      })
      .join(" OR ");
  }

  function validate(entry) {
    var errors = [];
    validateNode(entry, SCHEMA, "", errors);
    return { valid: errors.length === 0, errors: errors };
  }

  // Accepts a raw array, or a wrapper object whose first array-valued property
  // holds the entries (covers { games: [...] } and { tools: [...] }).
  function coerceEntries(entries) {
    if (Array.isArray(entries)) return entries;
    if (entries && typeof entries === "object") {
      var arrayKey = Object.keys(entries).find(function (key) {
        return Array.isArray(entries[key]);
      });
      if (arrayKey) return entries[arrayKey];
    }
    return null;
  }

  function validateAll(entries) {
    var list = coerceEntries(entries);
    if (list === null) {
      return {
        valid: false,
        errors: [
          "validateAll expected an array of entries or a manifest wrapper object",
        ],
      };
    }
    var allErrors = [];
    list.forEach(function (entry, i) {
      var result = validate(entry);
      if (!result.valid) {
        var label =
          entry && entry.id
            ? "entry[" + i + "] '" + entry.id + "'"
            : "entry[" + i + "]";
        result.errors.forEach(function (message) {
          allErrors.push(label + " " + message);
        });
      }
    });
    return { valid: allErrors.length === 0, errors: allErrors };
  }

  var api = { validate: validate, validateAll: validateAll, SCHEMA: SCHEMA };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ManifestValidator = api;
  }
})(
  typeof window !== "undefined"
    ? window
    : typeof globalThis !== "undefined"
      ? globalThis
      : this,
);
