
import pty, os, sys, select, struct, fcntl, termios, signal, subprocess

tmux, session, mobile, pane_idx, resize_file = sys.argv[1:6]

subprocess.run([tmux, 'new-session', '-d', '-t', session, '-s', mobile], check=True)
subprocess.run([tmux, 'set', '-t', mobile, 'status', 'off'])
if pane_idx != '0':
    subprocess.run([tmux, 'select-pane', '-t', mobile + ':.' + pane_idx], check=True)

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.environ['TERM'] = 'xterm-256color'
    os.execv(tmux, [tmux, 'attach', '-r', '-f', 'ignore-size', '-t', mobile])
os.close(slave)
fl = fcntl.fcntl(master, fcntl.F_GETFL)
fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)
fl_in = fcntl.fcntl(0, fcntl.F_GETFL)
fcntl.fcntl(0, fcntl.F_SETFL, fl_in | os.O_NONBLOCK)
sys.stdout = os.fdopen(1, 'wb', 0)

def on_winch(signum, frame):
    try:
        with open(resize_file, 'r') as f:
            parts = f.read().strip().split(',')
        cols, rows = int(parts[0]), int(parts[1])
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass
signal.signal(signal.SIGWINCH, on_winch)

try:
    while True:
        r, _, _ = select.select([master, 0], [], [], 1)
        if 0 in r:
            try:
                data = os.read(0, 65536)
                if not data:
                    break
                os.write(master, data)
            except OSError:
                break
        if master in r:
            try:
                data = os.read(master, 65536)
                if not data:
                    break
                sys.stdout.write(data)
            except OSError:
                break
        rr = os.waitpid(pid, os.WNOHANG)
        if rr[0] != 0:
            break
except Exception:
    pass
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    os.close(master)
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass
    try:
        os.unlink(resize_file)
    except Exception:
        pass
    subprocess.run([tmux, 'kill-session', '-t', mobile], capture_output=True)
    sys.exit(0)
