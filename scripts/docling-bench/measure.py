# Runs a command and reports its wall time and the peak RSS of its process
# tree. Runs inside the container, so the memory is Docling's, not Docker's.
import resource
import subprocess
import sys
import time

started = time.time()
result = subprocess.run(sys.argv[1:])
peak_mb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
print(f"exit={result.returncode} wall={time.time() - started:.1f}s peak={peak_mb:.0f}MB", file=sys.stderr)
sys.exit(result.returncode)
