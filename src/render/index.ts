import type { Spec } from '../schema.js'
import { renderJob } from './job.js'
import { renderService } from './service.js'

export function render(spec: Spec): Record<string, unknown> {
  return spec.kind === 'service' ? renderService(spec) : renderJob(spec)
}

export { renderJob, renderService }
