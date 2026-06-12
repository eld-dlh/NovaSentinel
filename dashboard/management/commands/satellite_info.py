from django.core.management.base import BaseCommand
from dashboard.models import ConjunctionAlert, RejectedTLE
from django.db.models import Q

class Command(BaseCommand):
    help = 'Look up PoC and other details of a satellite, including test events (RejectedTLEs).'

    def add_arguments(self, parser):
        parser.add_argument('satellite_id', type=str, help='The NORAD ID of the satellite')

    def handle(self, *args, **kwargs):
        sat_id = kwargs['satellite_id']

        self.stdout.write(self.style.SUCCESS(f"=== Information for Satellite (NORAD ID: {sat_id}) ==="))

        # Get Conjunction Alerts (PoC and details)
        conjunctions = ConjunctionAlert.objects.filter(
            Q(norad_primary=sat_id) | Q(norad_secondary=sat_id)
        ).order_by('-poc_score')

        if conjunctions.exists():
            self.stdout.write(self.style.WARNING("\n-- Conjunction Alerts --"))
            for c in conjunctions:
                other_sat = c.norad_secondary if c.norad_primary == sat_id else c.norad_primary
                other_name = c.name_secondary if c.norad_primary == sat_id else c.name_primary
                
                self.stdout.write(
                    f"Time of Closest Approach (TCA): {c.tca.strftime('%Y-%m-%d %H:%M:%S UTC')}\n"
                    f"Other Object: {other_name} (NORAD: {other_sat})\n"
                    f"Probability of Collision (PoC): {c.poc_score:.2e} (Severity: {c.severity.upper()})\n"
                    f"Miss Distance: {c.miss_distance} km\n"
                    f"Relative Velocity: {c.rel_velocity} km/s\n"
                    f"CDM ID: {c.cdm_id if c.cdm_id else 'N/A'}\n"
                    f"----------------------------------------"
                )
        else:
            self.stdout.write("\nNo Conjunction Alerts found for this satellite.")

        # Get Test Events (Rejected TLEs)
        rejected_tles = RejectedTLE.objects.filter(norad_id=sat_id).order_by('-rejected_at')

        if rejected_tles.exists():
            self.stdout.write(self.style.ERROR("\n-- TLE Test Events (Rejected TLEs) --"))
            for r in rejected_tles:
                self.stdout.write(
                    f"Rejected At: {r.rejected_at.strftime('%Y-%m-%d %H:%M:%S UTC')}\n"
                    f"Reason: {r.reason}\n"
                    f"Name in TLE: {r.object_name}\n"
                    f"----------------------------------------"
                )
        else:
            self.stdout.write("\nNo Test Events (Rejected TLEs) found for this satellite.")

        self.stdout.write(self.style.SUCCESS(f"\n=== End of Information for {sat_id} ==="))
