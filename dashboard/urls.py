"""
NovaSentinel — Dashboard app URL configuration.

All API endpoints are prefixed with /api/ in the root urls.py.
The dashboard template is served at the site root /.
"""

from django.urls import path
from . import views

urlpatterns = [
    # ── Template view (MVT) ────────────────────────────────────────────────
    path('', views.dashboard, name='dashboard'),

    # ── Space-Track / CelesTrak proxy (server-side auth) ──────────────────
    path('api/spacetrack-login/', views.proxy_spacetrack_login, name='spacetrack-login'),
    path('api/cdm/',              views.proxy_cdm,              name='proxy-cdm'),
    path('api/tle/',              views.proxy_tle,              name='proxy-tle'),
    path('api/omm/',              views.proxy_omm,              name='proxy-omm'),

    # ── Audit log writers (POST from jQuery AJAX) ──────────────────────────
    path('api/log-rejected-tle/', views.log_rejected_tle,       name='log-rejected-tle'),
    path('api/log-conjunction/',  views.log_conjunction,         name='log-conjunction'),

    # ── Read-back APIs ─────────────────────────────────────────────────────
    path('api/rejected-tles/',    views.get_rejected_tles,       name='rejected-tles'),
    path('api/conjunctions/',     views.get_conjunctions,        name='conjunctions'),
    path('api/stats/',            views.get_stats,               name='stats'),
]
