export class MemoryServiceError extends Error {
    code;
    status;
    requestId;
    constructor(code, message, status = statusForCode(code), requestId) {
        super(message);
        this.name = "MemoryServiceError";
        this.code = code;
        this.status = status;
        this.requestId = requestId;
    }
    toBody() {
        return { error: { code: this.code, message: this.message, requestId: this.requestId } };
    }
}
export function statusForCode(code) {
    switch (code) {
        case "invalid_argument":
            return 400;
        case "unauthorized":
            return 401;
        case "forbidden":
            return 403;
        case "not_found":
            return 404;
        case "conflict":
            return 409;
        case "rate_limited":
            return 429;
        default:
            return 500;
    }
}
