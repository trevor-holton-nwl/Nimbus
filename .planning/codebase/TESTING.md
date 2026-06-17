# Testing Patterns

**Analysis Date:** 2026-06-17

## Test Framework

**Status: NO AUTOMATED TESTS**

This codebase has **zero automated test coverage**. There are no test files, no test configuration, and no testing framework installed (pytest, Jest, Vitest, etc. not in `requirements.txt`).

**Testing approach:** Manual, documented in separate audit reports:
- `AUDIT_REPORT_BACKEND.md` — functional audit of Python endpoints and logic
- `AUDIT_REPORT_FRONTEND.md` — functional audit of JavaScript modules and UI
- `LINT_REPORT_BACKEND.md` — static analysis via ruff
- `LINT_REPORT_FRONTEND.md` — static analysis of JavaScript conventions

**Why no tests:**
- Project is in active prototyping/optimization phase (see git history: recent commits on perf, constraints, master data)
- Manual audits were preferred to establish baseline before building test suite
- Codebase is relatively young (first commits ~June 2026) with rapidly changing requirements

## Testing Recommendations

**Immediate Priority: Unit Tests**

**Backend (Python/FastAPI):**
- Framework: **pytest** + `pytest-asyncio` for async handlers
- Test structure: `tests/test_{module}.py` parallel to `{module}.py`
- Start with:
  1. `db.py` query functions — mock psycopg pool, test parameter binding, SQL safety
  2. `brain.py` endpoints — use `TestClient` from Starlette, mock DB
  3. `master_data.py` — parameterized queries, SQL injection prevention
- **Critical paths to test:**
  - Optimistic concurrency in `update_task_dates_bulk()` (xmin logic)
  - Error handling and request-ID threading through middleware
  - Color-wheel file loading fallback behavior
  - Excel upload ingestion (`db.ingest_orders_from_excel()`)

**Frontend (JavaScript):**
- Framework: **Vitest** (fast, modern, supports ESM) or **Jest** (more mature)
- Test structure: Co-locate tests next to modules — `app.test.js` next to `app.js`
- Start with:
  1. `Util` module — date parsing, formatting, snapping, interval merging
  2. `Store` mutations and pub/sub — verify `publish()` calls listeners correctly
  3. `Calendar` — working hours, blackout overlap detection, capacity calculation
  4. `Alerts` — overlap/overload/fixed-violation detection rules
- **Critical paths to test:**
  - Date boundary conditions (midnight, year boundaries, DST edge cases)
  - Store state consistency after mutation + undo
  - Alert recompute correctness (no false positives, no missed conflicts)
  - Interval merging for blackout union (overlapping blocks don't double-count)

**Integration Tests:**
- Test the full request/response cycle: frontend → backend → Postgres → response
- Mock the Postgres connection pool, not individual queries
- Example: `POST /tasks/update` with optimistic-concurrency conflict → verify stale ID is returned + Store updates correctly

**E2E Tests:**
- Framework: **Playwright** (already configured; see `.playwright-mcp/`)
- Scope: Happy paths for critical workflows (schedule an order, run optimization, fix an order)
- Browser automation against `http://localhost:9000` + `http://localhost:8000` locally

## Test File Organization

**Location (Recommended):**
```
project-root/
├── tests/
│   ├── conftest.py              # pytest shared fixtures, DB setup/teardown
│   ├── test_db.py               # db.py tests
│   ├── test_brain.py            # brain.py endpoint tests
│   ├── test_master_data.py       # master_data.py tests
│   ├── fixtures/
│   │   ├── orders.csv           # sample order data for uploads
│   │   └── color_wheel.xlsx     # sample color wheel for upload tests
│   └── e2e/
│       └── test_schedule_order.spec.ts  # Playwright tests
├── __tests__/   (OR: co-located with source)
│   ├── util.test.js
│   ├── store.test.js
│   ├── calendar.test.js
│   └── alerts.test.js
```

**Naming:**
- Test files: `test_{module}.py` (pytest convention) or `{module}.test.js` (Jest/Vitest)
- Test functions: `test_<function>_<scenario>` (e.g., `test_parseDate_returnsNullOnInvalid`, `test_updateTaskDatesBulk_rejectsStaleConcurrency`)
- Test suites: `describe('ModuleName', () => { ... })` (JavaScript)

## Test Structure

**Example: Python (pytest)**
```python
import pytest
from fastapi.testclient import TestClient
from brain import api
from unittest.mock import patch, MagicMock

@pytest.fixture
def client():
    return TestClient(api)

@pytest.fixture
def mock_db():
    with patch('brain.db') as m:
        yield m

def test_get_tasks_scoped_to_plant(client, mock_db):
    """GET /tasks?plant=5512 returns only orders for plant 5512."""
    mock_db.query_orders.return_value = pd.DataFrame([
        {'id': 'abc123', 'PLANT': '5512', 'PRODUCTION_LINE': 'Line1'},
    ])
    
    response = client.get('/tasks?plant=5512')
    
    assert response.status_code == 200
    mock_db.query_orders.assert_called_with(plant='5512', line=None, ...)
    data = response.json()
    assert len(data['tasks']) == 1
```

**Example: JavaScript (Vitest)**
```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { Util } from './app.js';

describe('Util', () => {
  describe('parseDate', () => {
    it('returns null for falsy input', () => {
      expect(Util.parseDate(null)).toBeNull();
      expect(Util.parseDate(undefined)).toBeNull();
      expect(Util.parseDate('')).toBeNull();
    });

    it('returns a Date instance for valid ISO strings', () => {
      const d = Util.parseDate('2026-06-17T14:30:00');
      expect(d).toBeInstanceOf(Date);
      expect(d.getFullYear()).toBe(2026);
    });

    it('clamps to nearest STEP_MS boundary', () => {
      const d = new Date('2026-06-17T14:37:42');
      const snapped = Util.snap(d);
      expect(snapped.getMinutes() % 15).toBe(0);
    });
  });

  describe('mergedOverlapHours', () => {
    it('returns 0 for non-overlapping intervals', () => {
      const win = [new Date('2026-06-17T08:00'), new Date('2026-06-17T10:00')];
      const intervals = [
        { s: new Date('2026-06-17T10:30'), e: new Date('2026-06-17T11:00') }
      ];
      expect(Util.mergedOverlapHours(win, intervals)).toBe(0);
    });

    it('merges overlapping blackout blocks', () => {
      const win = [new Date('2026-06-17T08:00'), new Date('2026-06-17T18:00')];
      const intervals = [
        { s: new Date('2026-06-17T12:00'), e: new Date('2026-06-17T13:00') },
        { s: new Date('2026-06-17T12:30'), e: new Date('2026-06-17T14:00') }
      ];
      expect(Util.mergedOverlapHours(win, intervals)).toBeCloseTo(1.5);
    });
  });
});
```

## Setup & Teardown

**Python (pytest):**
- `conftest.py` defines fixtures for DB connection, connection pool mock, test data
- `@pytest.fixture(scope='session')` for expensive setup (DB schema creation)
- `@pytest.fixture(scope='function')` for per-test cleanup (roll back transactions)

**JavaScript (Vitest):**
- Use `beforeEach()` to reset mocks, clear Store state, reset timers
- Use `afterEach()` to clean up DOM elements, cancel pending fetches

## Mocking

**Framework:**
- Python: `unittest.mock` (built-in)
- JavaScript: Vitest provides native `vi.mock()`, `vi.spyOn()`

**What to Mock:**
1. **Database connections** — isolate SQL logic from infrastructure
   - Mock `db._pool.connection()` to return a fake cursor
   - Verify parameterized query calls (not raw SQL strings)
   - Example: `mock_db.update_task_dates_bulk.return_value = {"persisted": 5, "stale": []}`

2. **HTTP calls** — isolate network from application logic
   - Mock `Util.fetchTraced()` in JavaScript tests
   - Mock `httpx` requests in Python backend tests
   - Return fixtures that mimic real API responses

3. **File I/O** — isolate file system from logic
   - Mock `open()` in Python when testing `load_color_wheels()`
   - Mock `pd.read_excel()` to return fixture DataFrames

4. **Timestamps** — freeze time for deterministic tests
   - `vi.useFakeTimers()` in JavaScript
   - `freezegun` library in Python

**What NOT to Mock:**
- Core business logic (e.g., actual `Util.mergedOverlapHours()` calculation)
- Date helpers (test the real implementations)
- Store mutations — test the actual pub/sub mechanism
- Validation rules (e.g., "end must be after start")

## Fixtures and Factories

**Test Data:**
```python
# tests/conftest.py
@pytest.fixture
def sample_orders():
    return pd.DataFrame([
        {
            'id': 'abc123',
            'PRODUCTION_ORDER': '1000261702',
            'MATERIAL_NUMBER': '5512-001',
            'PRODUCTION_LINE': 'Line1',
            'PLANT': '5512',
            'BASIC_START_DATE': datetime(2026, 6, 17, 8, 0),
            'BASIC_FINISH_DATE': datetime(2026, 6, 17, 12, 0),
            'RUN_TIME': 4.0,
            'COLOR': 'RED',
            'FORM_SIZE': 'Large',
        },
        { ... }
    ])

@pytest.fixture
def sample_excel_upload(tmp_path):
    """Create a temporary .xlsx file with test order data."""
    file = tmp_path / "test_upload.xlsx"
    df = pd.DataFrame([...])
    df.to_excel(file, index=False)
    return file
```

**Location:** `tests/fixtures/` or `tests/conftest.py` (shared fixtures)

**JavaScript:**
```javascript
// src/__tests__/fixtures.js
export const sampleTasks = [
  {
    id: 'abc123',
    PRODUCTION_LINE: 'Line1',
    start_date: new Date('2026-06-17T08:00'),
    end_date: new Date('2026-06-17T12:00'),
    RUN_TIME: 4,
    COLOR: 'RED',
  },
  // ...
];

export const sampleStore = {
  tasks: sampleTasks,
  calendars: { 'Line1': { workHours: [7, 19] } },
  blocks: [],
  plantBlocks: [],
  // ...
};
```

## Coverage

**Requirements:** None enforced currently.

**Target (Future):**
- **Backend:** 70%+ line coverage on hot paths (`db.py`, core `brain.py` handlers)
- **Frontend:** 60%+ on core modules (`Store`, `Calendar`, `Alerts`, `Util`)
- **Ignore:** UI render functions (low ROI for testing), Web Worker (minimal logic)

**View Coverage:**
```bash
# Python
pytest --cov=brain --cov=db --cov=master_data --cov-report=html

# JavaScript
vitest --coverage
```

## Test Types

**Unit Tests:**
- Scope: Single function or method in isolation
- Mocks: All dependencies (DB, network, file system)
- Speed: <100ms per test
- Examples: `Util.parseDate()`, `Calendar.isAvailable()`, `db.make_id()`

**Integration Tests:**
- Scope: Full request/response cycle (frontend → backend → Postgres mocked)
- Mocks: Connection pool only
- Speed: 100–500ms per test
- Examples: `POST /tasks/update` with concurrency conflict, `GET /tasks?plant=5512`

**E2E Tests (Playwright):**
- Scope: Real browser, real backend servers, real UI
- Mocks: Only external services (if needed)
- Speed: 1–5s per test
- Examples:
  - Schedule an order via drag/drop → verify save → refresh → order persisted
  - Run optimization → verify Gantt re-renders → verify KPIs update
  - Upload Excel → verify orders appear in table

**Performance Tests (Future):**
- Measure response times for hot paths (e.g., `GET /tasks` with 10k orders)
- Measure frontend render time for large datasets
- Memory usage under load (Web Worker off-thread compute cost)

## Common Patterns

**Async Testing (JavaScript):**
```javascript
it('fetches tasks from backend', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ tasks: [...] }),
  });

  const tasks = await Persistence.loadTasks();
  
  expect(tasks).toHaveLength(2);
  expect(global.fetch).toHaveBeenCalledWith(
    'http://localhost:8000/tasks?plant=5512',
    expect.any(Object)
  );
});
```

**Async Testing (Python):**
```python
@pytest.mark.asyncio
async def test_upload_orders_ingests_excel(client, mock_db, sample_excel_upload):
    """POST /upload reads .xlsx and calls db.ingest_orders_from_excel()."""
    with open(sample_excel_upload, 'rb') as f:
        response = client.post('/upload', files={'file': f})
    
    assert response.status_code == 200
    mock_db.ingest_orders_from_excel.assert_called_once()
    result = response.json()
    assert result['status'] == 'ok'
```

**Error Testing (JavaScript):**
```javascript
it('rejects inverted date ranges in modal', () => {
  const startInput = document.querySelector('.modal-start');
  const endInput = document.querySelector('.modal-end');

  startInput.value = '2026-06-17T14:00';
  endInput.value = '2026-06-17T12:00';
  
  const save = () => Inspector._saveTaskEdit();
  
  expect(save).toThrow(/End must be after start/);
});
```

**Error Testing (Python):**
```python
def test_update_task_dates_bulk_rejects_inverted_range(client, mock_db):
    """POST /tasks/update rejects end < start."""
    payload = {
        'tasks': [
            {
                'id': 'abc123',
                'start': '2026-06-17T14:00',
                'end': '2026-06-17T12:00',  # Invalid: end before start
            }
        ]
    }
    response = client.post('/tasks/update', json=payload)
    
    assert response.status_code == 400
    data = response.json()
    assert 'invalid' in data  # or 'stale', 'not_found'
```

## Running Tests

**When a test suite is created:**

```bash
# Python
pip install pytest pytest-asyncio pytest-cov pytest-mock
pytest tests/ -v --cov

# JavaScript
npm install --save-dev vitest @vitest/ui
vitest --ui
```

## Test Maintenance

**Known Brittleness:**
- Datetime comparisons — use `isoformat()` for string comparison, or frozen time in tests
- DOM-based tests — brittle if HTML structure changes; prefer querying by role/label
- Timezone-dependent tests — NIMBUS assumes `America/New_York` (Config.TZ); use frozen time + explicit timezone

---

*Testing analysis: 2026-06-17*
