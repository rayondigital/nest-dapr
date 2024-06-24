const serializableErrorTypeName = 'SerializableError';

/*
  An error that can be serialized to JSON, which does not throw a HTTP 500 error.
  This error is useful for operations that may fail, but should not be considered a critical error.
  The status code returned can be set by the caller.
  See: https://learn.microsoft.com/en-us/azure/architecture/best-practices/retry-service-specific
 */
export class SerializableError extends Error {
  $type = serializableErrorTypeName;
  correlationId?: string;
  traceId?: string;
  constructor(message: string, public statusCode: number = 400) {
    super(message);
  }
  toJSON() {
    // If no stack is provided then get the current stack
    if (!this.stack) {
      Error.captureStackTrace(this, SerializableError);
    }
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      correlationId: this.correlationId,
      traceId: this.traceId,
      stack: this.stack,
      $type: serializableErrorTypeName,
    };
  }

  static fromJSON(json: any): SerializableError {
    const error = new SerializableError(json.message, json.statusCode);
    error.$type = json.$type ?? serializableErrorTypeName;
    error.correlationId = json.correlationId;
    error.traceId = json.traceId;
    error.stack = json.stack;
    error.name = json.name;
    return error;
  }

  static isSerializableError(error: any): error is SerializableError {
    if (error instanceof SerializableError) {
      return true;
    }
    return error && error.$type === 'SerializableError';
  }
}
