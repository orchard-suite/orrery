/** A relation rule, an alert rule, or a change to the model the hub refuses, or a part of it the hub does not hold. */
export class DefinitionError extends Error {
  readonly status: 400 | 404
  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.status = status
  }
}
