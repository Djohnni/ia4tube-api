# Calendar availability correction — 2026-09-08

The production gallery returned503 in a direct authenticated API request, independently of Android37. Production PostgreSQL logs showed an idle-in-transaction termination at21:54:52 Brasília and repeated foreign-key failures from the background calendar attempting to initialize historical product owners absent from the social company catalog. The idle timeout's underlying trigger is not established; the foreign-key traffic alone does not prove causation.

The physical local PostgreSQL regression reproduced a separate, concrete handling defect: a checked-out client can emit an `error` event as well as reject its active query. The existing transaction helper had no checked-out error listener. Catching the promise alone was insufficient; the regression failed with an uncaught connection error. A temporary listener now retains that failure, prevents commit after an observed error, removes the broken client, and detaches without leaking listeners. Healthy transactions and ordinary business rollbacks keep existing behavior.

The gallery GET may retry exactly once for recognized connection-termination errors. This does not retry edits, consent, worker/provider writes, OAuth, lock timeouts, permission/constraint errors or unknown exceptions. An unsuccessful recovery remains a sanitized503, never a fabricated empty-success response. Only a fixed diagnostic component/code is passed to the existing logger; its production sink may render a generic safe message.

The worker first reads whether that company's calendar has already been initialized. Normal authenticated gallery access/consent initializes it under existing tenant readiness. Background work no longer creates state for every historical account. No account is deleted, provisioned, reassigned or implicitly authorized by this change.

Validation covers focal calendar and HTTP/production compatibility, shared transaction lifecycle, forced tenant isolation, unchanged calendar reads, and a physical local PostgreSQL connection terminated mid-query and by idle timeout. Synthetic PostgreSQL startup was adjusted to avoid Windows child processes inheriting captured launcher pipes. No production failure is injected.

No schema migration, dependency change, timeout increase, TLS relaxation, gate opening, external publication, credential change or Android rebuild is part of this patch. Existing Android38 artifact remains unchanged. Production deployment and subsequent live/phone checks must be recorded separately; passing local tests is not a claim of live validation.
