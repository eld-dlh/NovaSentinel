from django.core.management.base import BaseCommand
from dashboard.models import ConjunctionAlert
from datetime import datetime, timezone

class Command(BaseCommand):
    help = 'Seeds a high-risk dummy collision event to demonstrate the system is working smoothly.'

    def handle(self, *args, **kwargs):
        # Create a high-risk conjunction for NOAA 15
        record = ConjunctionAlert.objects.create(
            norad_primary='25338',
            name_primary='NOAA 15',
            norad_secondary='29677',
            name_secondary='COSMOS 2251 DEB',
            poc_score=0.0015, # 1.5e-3 (High/Critical)
            miss_distance=0.098,
            rel_velocity=14.2,
            tca=datetime.now(timezone.utc),
            severity='critical',
            is_debris=True,
            cdm_id='2024-001-C'
        )

        self.stdout.write(self.style.SUCCESS(f"Successfully added a high-risk collision event!"))
        self.stdout.write(self.style.SUCCESS(f"Primary: NOAA 15 (NORAD: 25338)"))
        self.stdout.write(self.style.SUCCESS(f"Secondary: COSMOS 2251 DEB (NORAD: 29677)"))
        self.stdout.write(self.style.SUCCESS(f"PoC: 1.5e-3 (Critical Severity)"))
        self.stdout.write(self.style.SUCCESS(f"\nYou can now view this in the dashboard or run:"))
        self.stdout.write(self.style.SUCCESS(f"python manage.py satellite_info 25338"))
