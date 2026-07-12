import pytest

from clusterer.config import get_settings


def pytest_collectreport(report: pytest.CollectReport) -> None:
    """Abort immediately on collection errors (broken imports, syntax errors).

    Without this, pytest silently skips broken test files and reports
    "N passed" with no indication that a module was excluded.
    """
    if report.failed:
        raise pytest.UsageError(f"Collection failed: {report.nodeid}\n{report.longrepr}")


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
