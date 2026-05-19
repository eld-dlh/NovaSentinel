"""
NovaSentinel — Dashboard views.

All views satisfy syllabus Module 1 (Django Views + MVT pattern):

Template view:
    dashboard(request)          — serves index.html as a Django template at /

Proxy views (Space-Track & CelesTrak — CORS-safe, authenticated server-side):
    proxy_cdm(request)          — GET  /api/cdm/
    proxy_tle(request)          — GET  /api/tle/
    proxy_omm(request)          — GET  /api/omm/
    proxy_spacetrack_login(request) — POST /api/spacetrack-login/

Audit log writers (called by frontend AJAX — satisfies Module 5 jQuery/AJAX):
    log_rejected_tle(request)   — POST /api/log-rejected-tle/
    log_conjunction(request)    — POST /api/log-conjunction/

Read-back APIs (for admin supplement + frontend stats):
    get_rejected_tles(request)  — GET  /api/rejected-tles/
    get_conjunctions(request)   — GET  /api/conjunctions/
    get_stats(request)          — GET  /api/stats/
"""

import json
import logging
from datetime import datetime, timezone

import requests as req_lib
from django.conf        import settings
from django.http        import JsonResponse
from django.shortcuts   import render
from django.views.decorators.csrf  import csrf_exempt
from django.views.decorators.http  import require_POST, require_GET
from django.utils.decorators       import method_decorator

from .models import RejectedTLE, ConjunctionAlert

logger = logging.getLogger(__name__)

# ── Space-Track session (shared across requests in a single worker process) ──
_st_session = req_lib.Session()

# ─────────────────────────────────────────────────────────────────────────────
# 1. Template view — serves the Three.js dashboard as a Django template
# ─────────────────────────────────────────────────────────────────────────────

def dashboard(request):
    """
    Serves dashboard/templates/dashboard.html via Django's render() helper.
    Satisfies the MVT template requirement: the view passes context variables
    so the template can display the Space-Track identity and live DB counts.
    """
    context = {
        'spacetrack_identity': settings.SPACETRACK_IDENTITY or '',
        'rejected_count':      RejectedTLE.objects.count(),
        'conjunction_count':   ConjunctionAlert.objects.count(),
        'title':               'NovaSentinel — Space Situational Awareness',
    }
    return render(request, 'dashboard.html', context)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Space-Track proxy — server-side authentication (no CORS leakage)
# ─────────────────────────────────────────────────────────────────────────────

def proxy_spacetrack_login(request):
    """
    POST /api/spacetrack-login/

    Authenticates with Space-Track using credentials stored in settings.py
    (read from env vars — never exposed to the browser).  Sets a server-side
    session cookie that all subsequent proxy views reuse.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    identity = settings.SPACETRACK_IDENTITY
    password = settings.SPACETRACK_PASSWORD

    if not identity or not password:
        return JsonResponse(
            {'error': 'Space-Track credentials not configured (set SPACETRACK_IDENTITY and SPACETRACK_PASSWORD)'},
            status=503
        )

    try:
        resp = _st_session.post(
            'https://www.space-track.org/ajaxauth/login',
            data={'identity': identity, 'password': password},
            timeout=20,
        )
        resp.raise_for_status()
        logger.info('[proxy] Space-Track login successful')
        return JsonResponse({'status': 'logged in'})
    except Exception as exc:
        logger.error('[proxy] Space-Track login failed: %s', exc)
        return JsonResponse({'error': str(exc)}, status=502)


@require_GET
def proxy_cdm(request):
    """
    GET /api/cdm/

    Proxies the Space-Track CDM public endpoint.  The server session cookie
    (obtained via proxy_spacetrack_login) is sent automatically.

    Optional query params:
        limit   — max records (default 1000)
        hours   — look-back window in hours (default 24)
    """
    limit  = request.GET.get('limit', '1000')
    hours  = request.GET.get('hours', '24')

    # Fetch TCA from Space-Track CDM public class
    url = (
        f'https://www.space-track.org/basicspacedata/query'
        f'/class/cdm_public/CREATED/%3Enow-{hours}h'
        f'/orderby/TCA%20asc/limit/{limit}/format/json'
    )

    try:
        resp = _st_session.get(url, timeout=30)
        if resp.status_code in (401, 403):
            # Auto-retry after login
            _do_spacetrack_login()
            resp = _st_session.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        logger.info('[proxy_cdm] %d CDM records returned', len(data) if isinstance(data, list) else 0)
        return JsonResponse(data, safe=False)
    except Exception as exc:
        logger.error('[proxy_cdm] %s', exc)
        return JsonResponse({'error': str(exc)}, status=502)


@require_GET
def proxy_tle(request):
    """
    GET /api/tle/

    Proxies the CelesTrak GP TLE endpoint (no auth required — public data).

    Query params:
        group   — CelesTrak group name (default 'active')
        format  — 'tle' or 'json' (default 'tle')
    """
    group  = request.GET.get('group',  'active')
    fmt    = request.GET.get('format', 'tle')
    url    = f'https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT={fmt}'

    try:
        resp = req_lib.get(url, timeout=30, headers={'Accept': 'text/plain'})
        resp.raise_for_status()
        if fmt == 'json':
            return JsonResponse(resp.json(), safe=False)
        return JsonResponse({'raw': resp.text, 'group': group})
    except Exception as exc:
        logger.error('[proxy_tle] %s', exc)
        return JsonResponse({'error': str(exc)}, status=502)


@require_GET
def proxy_omm(request):
    """
    GET /api/omm/

    Proxies the CelesTrak OMM JSON endpoint (structured orbital data).
    """
    group = request.GET.get('group', 'active')
    url   = f'https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json'

    try:
        resp = req_lib.get(url, timeout=30)
        resp.raise_for_status()
        return JsonResponse(resp.json(), safe=False)
    except Exception as exc:
        logger.error('[proxy_omm] %s', exc)
        return JsonResponse({'error': str(exc)}, status=502)


def _do_spacetrack_login():
    """Internal helper — re-authenticates the shared session."""
    _st_session.post(
        'https://www.space-track.org/ajaxauth/login',
        data={
            'identity': settings.SPACETRACK_IDENTITY,
            'password': settings.SPACETRACK_PASSWORD,
        },
        timeout=20,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Audit log writers — called by jQuery $.ajax from the frontend
# ─────────────────────────────────────────────────────────────────────────────

@csrf_exempt
@require_POST
def log_rejected_tle(request):
    """
    POST /api/log-rejected-tle/

    Accepts a JSON body from the frontend TLE validator and persists the
    rejection record to PostgreSQL via the RejectedTLE model.

    Expected JSON:
        {
          "noradId":    "25544",
          "name":       "ISS (ZARYA)",
          "reason":     "Line 1 checksum mismatch",
          "line1":      "1 25544U ...",
          "line2":      "2 25544 ..."
        }
    """
    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    norad_id    = str(body.get('noradId', ''))
    object_name = str(body.get('name',    ''))
    reason      = str(body.get('reason',  'Unknown'))
    line1       = str(body.get('line1',   ''))
    line2       = str(body.get('line2',   ''))

    if not norad_id:
        return JsonResponse({'error': 'noradId is required'}, status=400)

    record = RejectedTLE.objects.create(
        norad_id    = norad_id,
        object_name = object_name,
        reason      = reason,
        raw_line1   = line1,
        raw_line2   = line2,
    )
    logger.info('[log_rejected_tle] Saved rejection %d — %s: %s', record.pk, norad_id, reason)
    return JsonResponse({'id': record.pk, 'status': 'saved'}, status=201)


@csrf_exempt
@require_POST
def log_conjunction(request):
    """
    POST /api/log-conjunction/

    Persists a conjunction event after the TF.js PoC model scores it above
    the configured threshold.  Called by the frontend AJAX handler.

    Expected JSON:
        {
          "noradPrimary":   "25544",
          "namePrimary":    "ISS (ZARYA)",
          "noradSecondary": "40000",
          "nameSecondary":  "COSMOS 2251 DEB",
          "pocScore":       1.23e-4,
          "missDistance":   0.8,
          "relVelocity":    11.2,
          "tca":            "2025-07-01T14:30:00Z",
          "isDebris":       true,
          "cdmId":          "12345"
        }
    """
    try:
        body = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    poc = float(body.get('pocScore', 0))
    if   poc >= 1e-2: severity = 'critical'
    elif poc >= 1e-3: severity = 'high'
    elif poc >= 1e-4: severity = 'medium'
    else:             severity = 'low'

    tca_raw = body.get('tca')
    try:
        tca_dt = datetime.fromisoformat(tca_raw.replace('Z', '+00:00')) if tca_raw else datetime.now(timezone.utc)
    except (ValueError, AttributeError):
        tca_dt = datetime.now(timezone.utc)

    record = ConjunctionAlert.objects.create(
        norad_primary   = str(body.get('noradPrimary',   '')),
        name_primary    = str(body.get('namePrimary',    '')),
        norad_secondary = str(body.get('noradSecondary', '')),
        name_secondary  = str(body.get('nameSecondary',  '')),
        poc_score       = poc,
        miss_distance   = float(body.get('missDistance', 0)),
        rel_velocity    = float(body.get('relVelocity',  0)),
        tca             = tca_dt,
        severity        = severity,
        is_debris       = bool(body.get('isDebris', False)),
        cdm_id          = str(body.get('cdmId', '')),
    )
    logger.info('[log_conjunction] Saved alert %d — PoC=%.2e', record.pk, poc)
    return JsonResponse({'id': record.pk, 'severity': severity, 'status': 'saved'}, status=201)


# ─────────────────────────────────────────────────────────────────────────────
# 4. Read-back APIs
# ─────────────────────────────────────────────────────────────────────────────

@require_GET
def get_rejected_tles(request):
    """GET /api/rejected-tles/ — returns the last 200 TLE rejection records."""
    limit = int(request.GET.get('limit', 200))
    qs    = RejectedTLE.objects.order_by('-rejected_at')[:limit]
    return JsonResponse([{
        'id':          r.pk,
        'noradId':     r.norad_id,
        'name':        r.object_name,
        'reason':      r.reason,
        'rejectedAt':  r.rejected_at.isoformat(),
    } for r in qs], safe=False)


@require_GET
def get_conjunctions(request):
    """GET /api/conjunctions/ — returns the top 200 conjunction alerts by PoC."""
    limit    = int(request.GET.get('limit', 200))
    severity = request.GET.get('severity', '')
    qs       = ConjunctionAlert.objects.order_by('-poc_score')
    if severity:
        qs = qs.filter(severity=severity)
    qs = qs[:limit]
    return JsonResponse([{
        'id':             c.pk,
        'noradPrimary':   c.norad_primary,
        'namePrimary':    c.name_primary,
        'noradSecondary': c.norad_secondary,
        'nameSecondary':  c.name_secondary,
        'pocScore':       c.poc_score,
        'missDistance':   c.miss_distance,
        'relVelocity':    c.rel_velocity,
        'tca':            c.tca.isoformat(),
        'severity':       c.severity,
        'isDebris':       c.is_debris,
        'cdmId':          c.cdm_id,
        'createdAt':      c.created_at.isoformat(),
    } for c in qs], safe=False)


@require_GET
def get_stats(request):
    """GET /api/stats/ — quick DB stats for the dashboard header widget."""
    return JsonResponse({
        'totalRejectedTLEs':  RejectedTLE.objects.count(),
        'totalConjunctions':  ConjunctionAlert.objects.count(),
        'criticalAlerts':     ConjunctionAlert.objects.filter(severity='critical').count(),
        'highAlerts':         ConjunctionAlert.objects.filter(severity='high').count(),
    })
