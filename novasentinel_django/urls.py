"""
NovaSentinel — root URL configuration.

Public routes:
    /              → dashboard (Three.js globe served as a Django template)
    /api/          → REST proxy views (TLE, CDM, OMM, audit log)
    /admin/        → Django admin interface
"""

from django.contrib import admin
from django.urls     import path, include
from django.conf     import settings
from django.conf.urls.static import static

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/',   include('dashboard.urls')),
    path('',       include('dashboard.urls')),  # dashboard root at /
]

# Serve static & media in DEBUG mode (Vite dist/ is exposed as /static/)
if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    
    # Serve Vite's public folder at the root (for /textures, /model, etc)
    from django.views.static import serve
    import os
    public_dir = os.path.join(settings.BASE_DIR, 'public')
    urlpatterns += [
        path('<path:path>', serve, {'document_root': public_dir}),
    ]
