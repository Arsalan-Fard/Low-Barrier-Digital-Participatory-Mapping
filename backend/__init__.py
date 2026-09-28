import threading

# Set when the app stops; every worker loop watches it.
shutdown_event = threading.Event()
