# Offline Glossary Quality Evaluation

This evaluation uses synthetic finance and commercial-real-estate statements.
It must not be replaced with production transcripts, customer documents,
emails, access codes, session identifiers, provider prompts, or model output.

The evaluator reports only fixed workload/model/result labels and numeric
aggregates. It measures:

- final target-term accuracy after deterministic retrieval and correction;
- prohibited rendering and unrelated-correction counts;
- number/negation preservation failures;
- deterministic repeat consistency as a cache-behavior proxy;
- local glossary-path p50/p95 latency and maximum selected-slice size.

The release gate is at least 95% target-term accuracy, zero prohibited
renderings, zero unrelated corrections, zero invariant failures, and no more
than 300 ms added p95 latency. A failure must be fixed in deterministic term
selection/correction or explicitly returned for product review; weakening the
fixture is not an accepted tuning decision.
