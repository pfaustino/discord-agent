// An HTTP status carried on an exception, so a handler can refuse a request
// from wherever it noticed the problem instead of threading a status back up.
//
// Its own module so route modules can throw it without importing server.js,
// which imports them.
export class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}
