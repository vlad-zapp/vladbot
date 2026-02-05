import { describe, it, expect } from "vitest";
import { classifyLLMError } from "../services/ai/errorClassifier.js";

describe("classifyLLMError", () => {
  describe("CONTEXT_LIMIT errors", () => {
    it("classifies context length exceeded errors", () => {
      const result = classifyLLMError(new Error("context length exceeded"));
      expect(result.code).toBe("CONTEXT_LIMIT");
      expect(result.recoverable).toBe(true);
    });

    it("classifies too many tokens errors", () => {
      const result = classifyLLMError(new Error("too many tokens in request"));
      expect(result.code).toBe("CONTEXT_LIMIT");
      expect(result.recoverable).toBe(true);
    });

    it("classifies maximum token errors", () => {
      const result = classifyLLMError(new Error("maximum token limit reached"));
      expect(result.code).toBe("CONTEXT_LIMIT");
      expect(result.recoverable).toBe(true);
    });

    it("classifies input too long errors", () => {
      const result = classifyLLMError(new Error("input is too long"));
      expect(result.code).toBe("CONTEXT_LIMIT");
      expect(result.recoverable).toBe(true);
    });
  });

  describe("RATE_LIMIT errors", () => {
    it("classifies rate limit errors", () => {
      const result = classifyLLMError(new Error("rate limit exceeded"));
      expect(result.code).toBe("RATE_LIMIT");
      expect(result.recoverable).toBe(true);
    });

    it("classifies too many requests errors", () => {
      const result = classifyLLMError(new Error("too many requests"));
      expect(result.code).toBe("RATE_LIMIT");
      expect(result.recoverable).toBe(true);
    });

    it("classifies 429 status errors", () => {
      const result = classifyLLMError(new Error("API error (429): Rate limited"));
      expect(result.code).toBe("RATE_LIMIT");
      expect(result.recoverable).toBe(true);
    });

    it("classifies quota exceeded errors", () => {
      const result = classifyLLMError(new Error("quota exceeded for today"));
      expect(result.code).toBe("RATE_LIMIT");
      expect(result.recoverable).toBe(true);
    });

    it("classifies overloaded errors", () => {
      const result = classifyLLMError(new Error("server overloaded"));
      expect(result.code).toBe("RATE_LIMIT");
      expect(result.recoverable).toBe(true);
    });
  });

  describe("AUTH_ERROR errors", () => {
    it("classifies authentication errors", () => {
      const result = classifyLLMError(new Error("authentication failed"));
      expect(result.code).toBe("AUTH_ERROR");
      expect(result.recoverable).toBe(false);
    });

    it("classifies invalid API key errors", () => {
      const result = classifyLLMError(new Error("invalid api key"));
      expect(result.code).toBe("AUTH_ERROR");
      expect(result.recoverable).toBe(false);
    });

    it("classifies unauthorized errors", () => {
      const result = classifyLLMError(new Error("unauthorized access"));
      expect(result.code).toBe("AUTH_ERROR");
      expect(result.recoverable).toBe(false);
    });

    it("classifies 401 status errors", () => {
      const result = classifyLLMError(new Error("API error (401): Unauthorized"));
      expect(result.code).toBe("AUTH_ERROR");
      expect(result.recoverable).toBe(false);
    });

    it("classifies 403 status errors", () => {
      const result = classifyLLMError(new Error("API error (403): Forbidden"));
      expect(result.code).toBe("AUTH_ERROR");
      expect(result.recoverable).toBe(false);
    });
  });

  describe("PROVIDER_ERROR errors", () => {
    it("classifies 500 server errors", () => {
      const result = classifyLLMError(new Error("API error (500): Internal Server Error"));
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.recoverable).toBe(true);
    });

    it("classifies 502 gateway errors", () => {
      const result = classifyLLMError(new Error("API error (502): Bad Gateway"));
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.recoverable).toBe(true);
    });

    it("classifies network errors", () => {
      const result = classifyLLMError(new Error("network error occurred"));
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.recoverable).toBe(true);
    });

    it("classifies connection refused errors", () => {
      const result = classifyLLMError(new Error("ECONNREFUSED"));
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.recoverable).toBe(true);
    });

    it("classifies timeout errors", () => {
      const result = classifyLLMError(new Error("ETIMEDOUT"));
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.recoverable).toBe(true);
    });

    it("classifies fetch failed errors", () => {
      const result = classifyLLMError(new Error("fetch failed"));
      expect(result.code).toBe("PROVIDER_ERROR");
      expect(result.recoverable).toBe(true);
    });
  });

  describe("UNKNOWN errors", () => {
    it("classifies unrecognized errors as UNKNOWN", () => {
      const result = classifyLLMError(new Error("something weird happened"));
      expect(result.code).toBe("UNKNOWN");
      expect(result.recoverable).toBe(false);
    });

    it("preserves the original error message", () => {
      const result = classifyLLMError(new Error("custom error message"));
      expect(result.message).toBe("custom error message");
    });
  });

  describe("DeepSeek specific errors", () => {
    it("classifies DeepSeek 400 invalid request errors", () => {
      const result = classifyLLMError(
        new Error('DeepSeek API error (400): {"error":{"message":"Messages with role \'tool\' must be a response to a preceding message with \'tool_calls\'","type":"invalid_request_error"}}'),
      );
      // This is an UNKNOWN error (not context/rate/auth/provider)
      expect(result.code).toBe("UNKNOWN");
      expect(result.message).toContain("tool");
    });
  });
});
