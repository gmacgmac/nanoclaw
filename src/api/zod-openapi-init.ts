// Side-effect module: patches ZodType.prototype.openapi so the
// @asteasolutions/zod-to-openapi registry can attach refIds to schemas.
//
// CRITICAL: This must be imported before any schema that will be registered
// with OpenAPIRegistry. In practice: import this from src/api/schemas/index.ts
// so the barrel guarantees ordering for the whole api/ subtree.
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);
