from .views.routes import health


def service_health():
    return health()
