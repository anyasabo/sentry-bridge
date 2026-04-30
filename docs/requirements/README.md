# SentryBridge — System Specification

This specification follows [ISO/IEC 29148](https://www.iso.org/standard/72089.html) (Systems and Software Engineering — Life Cycle Processes — Requirements Engineering).

## Documents

| #   | Document                                                         | Content                                          |
| --- | ---------------------------------------------------------------- | ------------------------------------------------ |
| 1   | [System Overview and Context](01-overview.md)                    | Product purpose, system boundaries, stakeholders |
| 2   | [Functional Requirements](02-functional-requirements.md)         | Testable functional requirements (SRS-001 …)     |
| 3   | [Non-Functional Requirements](03-non-functional-requirements.md) | Performance, reliability, security, portability  |
| 4   | [Interfaces](04-interfaces.md)                                   | External and internal interface specifications   |
| —   | [api.yaml](api.yaml)                                             | OpenAPI 3.0 spec for the SentryBridge REST API   |

> Migration to per-requirement IREB-style files (`REQ-NNNN-*.md`) is tracked in issue [#28](https://github.com/reneleban/sentry-bridge/issues/28).
