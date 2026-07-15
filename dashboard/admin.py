"""
NovaSentinel — Django admin registration.

Satisfies syllabus Module 3: Django admin interface.

Both models are registered with custom ModelAdmin classes that provide:
  - Searchable fields
  - List filters
  - Date-based drilldown navigation
  - Read-only audit display

Access at:  http://localhost:8000/admin/
"""

from django.contrib import admin
from .models import RejectedTLE, ConjunctionAlert

# ─────────────────────────────────────────────────────────────────────────────
# Admin site branding
# ─────────────────────────────────────────────────────────────────────────────
admin.site.site_header  = 'NovaSentinel Administration'
admin.site.site_title   = 'NovaSentinel Admin'
admin.site.index_title  = 'Space Situational Awareness — Audit Console'


# ─────────────────────────────────────────────────────────────────────────────
# RejectedTLE admin
# ─────────────────────────────────────────────────────────────────────────────

@admin.register(RejectedTLE)
class RejectedTLEAdmin(admin.ModelAdmin):
    list_display  = ['norad_id', 'object_name', 'reason', 'rejected_at']
    list_filter   = ['reason', 'rejected_at']
    search_fields = ['norad_id', 'object_name', 'reason']
    readonly_fields = ['norad_id', 'object_name', 'reason', 'raw_line1', 'raw_line2', 'rejected_at']
    date_hierarchy  = 'rejected_at'
    ordering        = ['-rejected_at']

    fieldsets = (
        ('Object Identity', {
            'fields': ('norad_id', 'object_name'),
        }),
        ('Rejection Details', {
            'fields': ('reason', 'rejected_at'),
        }),
        ('Raw TLE Data', {
            'classes': ('collapse',),
            'fields':  ('raw_line1', 'raw_line2'),
        }),
    )

    def has_add_permission(self, request):
        return False   # Rejections are only written by the pipeline

    def has_change_permission(self, request, obj=None):
        return False   # Audit log is immutable


# ─────────────────────────────────────────────────────────────────────────────
# ConjunctionAlert admin
# ─────────────────────────────────────────────────────────────────────────────

@admin.register(ConjunctionAlert)
class ConjunctionAlertAdmin(admin.ModelAdmin):
    list_display  = [
        'norad_primary', 'name_primary',
        'norad_secondary', 'name_secondary',
        'poc_score', 'miss_distance', 'severity', 'tca', 'created_at',
    ]
    list_filter   = ['severity', 'is_debris', 'tca']
    search_fields = ['norad_primary', 'name_primary', 'norad_secondary', 'name_secondary', 'cdm_id']
    date_hierarchy = 'tca'
    ordering       = ['-poc_score']

    readonly_fields = [
        'norad_primary', 'name_primary', 'norad_secondary', 'name_secondary',
        'poc_score', 'miss_distance', 'rel_velocity', 'tca',
        'severity', 'is_debris', 'cdm_id', 'created_at',
    ]

    fieldsets = (
        ('Primary Object', {
            'fields': ('norad_primary', 'name_primary'),
        }),
        ('Secondary Object', {
            'fields': ('norad_secondary', 'name_secondary', 'is_debris'),
        }),
        ('Conjunction Parameters', {
            'fields': ('poc_score', 'miss_distance', 'rel_velocity', 'tca', 'severity'),
        }),
        ('Metadata', {
            'fields': ('cdm_id', 'created_at'),
        }),
    )

    def has_add_permission(self, request):
        return False   # Alerts are only written by the pipeline

    def has_change_permission(self, request, obj=None):
        return False   # Audit log is immutable
