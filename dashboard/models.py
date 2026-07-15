"""
NovaSentinel — Dashboard app models.

Two models satisfy the syllabus requirements (Module 2 — Django Models,
Module 3 — Django Admin, PostgreSQL):

  RejectedTLE      — audit log of TLE records rejected by tleValidator.js
                     (per Shigol et al. [8] FRAME model-poisoning threat).
  ConjunctionAlert — persisted conjunction events scored by the ML PoC model.

Both are registered in admin.py for the Django admin panel.
"""

from django.db import models


class RejectedTLE(models.Model):
    """
    Stores every TLE record that failed validation in the NovaSentinel pipeline.

    The frontend JS validator flags rejections via POST /api/log-rejected-tle/
    which writes them here.  The Django admin panel at /admin/ then lets the
    operator browse, filter, and search the full rejection history.
    """

    norad_id    = models.CharField(max_length=10,  db_index=True,
                                   help_text='NORAD catalogue number of the rejected object')
    object_name = models.CharField(max_length=100, blank=True,
                                   help_text='Common name as supplied in the TLE header line')
    reason      = models.CharField(max_length=200,
                                   help_text='Human-readable rejection reason from the validator')
    raw_line1   = models.TextField(blank=True, help_text='Raw TLE line 1 (69 chars)')
    raw_line2   = models.TextField(blank=True, help_text='Raw TLE line 2 (69 chars)')
    rejected_at = models.DateTimeField(auto_now_add=True, db_index=True,
                                       help_text='UTC timestamp of rejection')

    class Meta:
        ordering        = ['-rejected_at']
        verbose_name    = 'Rejected TLE'
        verbose_name_plural = 'Rejected TLEs'

    def __str__(self):
        return f'{self.object_name or self.norad_id} — {self.reason} @ {self.rejected_at:%Y-%m-%d %H:%M}'


class ConjunctionAlert(models.Model):
    """
    Records conjunction events that exceed the configured PoC threshold.

    Populated via POST /api/log-conjunction/ from the frontend after the
    TensorFlow.js PoC inference step in main.js.
    """

    SEVERITY_CHOICES = [
        ('low',      'Low (PoC < 1e-4)'),
        ('medium',   'Medium (1e-4 ≤ PoC < 1e-3)'),
        ('high',     'High (PoC ≥ 1e-3)'),
        ('critical', 'Critical (PoC ≥ 1e-2)'),
    ]

    norad_primary   = models.CharField(max_length=10,
                                       help_text='NORAD ID of the primary (larger) object')
    name_primary    = models.CharField(max_length=100, blank=True)
    norad_secondary = models.CharField(max_length=10,
                                       help_text='NORAD ID of the secondary (debris/payload)')
    name_secondary  = models.CharField(max_length=100, blank=True)

    poc_score       = models.FloatField(help_text='ML-inferred Probability of Collision')
    miss_distance   = models.FloatField(help_text='Miss distance in km at TCA')
    rel_velocity    = models.FloatField(default=0.0,
                                        help_text='Relative velocity in km/s at TCA')
    tca             = models.DateTimeField(help_text='Time of Closest Approach (UTC)')
    severity        = models.CharField(max_length=10, choices=SEVERITY_CHOICES, default='low')
    is_debris       = models.BooleanField(default=False)

    cdm_id          = models.CharField(max_length=50, blank=True,
                                       help_text='Space-Track CDM_ID if available')
    created_at      = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering        = ['-poc_score']
        verbose_name    = 'Conjunction Alert'
        verbose_name_plural = 'Conjunction Alerts'

    def __str__(self):
        prim = self.name_primary or self.norad_primary
        sec  = self.name_secondary or self.norad_secondary
        return f'{prim} × {sec} | PoC={self.poc_score:.2e} | {self.tca:%Y-%m-%d %H:%M}'
