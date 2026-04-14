# Testing Documentation

This directory contains the testing documentation for SentryBridge, structured according to ISO/IEC 29119.

## Contents

| File | Requirement | Description |
|------|-------------|-------------|
| [01-strategy.md](./01-strategy.md) | TEST-01 | Test strategy: levels, tools, and coverage goals |
| [02-concept.md](./02-concept.md) | TEST-02 | Test concept: unit, integration, and hardware-UAT approach |
| [03-test-cases.md](./03-test-cases.md) | TEST-03 | Representative test cases for key scenarios |

## Quick Reference

| Aspect | Detail |
|--------|--------|
| Backend test framework | Jest with ts-jest |
| Test location | `src/__tests__/` |
| Run tests | `npm run test:backend` |
| Test reports | `reports/test-report.html`, `reports/junit.xml` |
| Total tests (v1.1.0) | 210+ |
| TDD scope | Config, PrusaLink Client, Obico Agent |
| Hardware-UAT | Manual, on Prusa Core One |
