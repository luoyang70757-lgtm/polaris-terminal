import pty, os, sys, select, socket, threading

def strip_iac(data):
    out = bytearray(); i = 0
    while i < len(data):
        b = data[i]
        if b != 255:
            out.append(b); i += 1; continue
        if i + 1 >= len(data): break
        cmd = data[i+1]
        if cmd == 255: out.append(255); i += 2; continue
        if cmd == 250:  # SB ... SE
            j = i + 2
            while j < len(data)-1 and not (data[j] == 255 and data[j+1] == 240):
                j += 1
            i = j + 2; continue
        i += 3  # IAC cmd opt
    return bytes(out)

def handle(conn):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp('/bin/bash', ['/bin/bash', '--norc', '--noprofile', '-i'])
    os.set_blocking(fd, False)
    conn.setblocking(False)
    while True:
        r, _, _ = select.select([fd, conn.fileno()], [], [], 1.0)
        try:
            if fd in r:
                d = os.read(fd, 65536)
                if not d: break
                conn.sendall(d)
            if conn.fileno() in r:
                d = conn.recv(65536)
                if not d: break
                os.write(fd, strip_iac(d))
        except (OSError, ConnectionResetError):
            break
    try: os.kill(pid, 9)
    except: pass
    try: conn.close()
    except: pass

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', int(sys.argv[1])))
s.listen(5)
print('READY', flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
