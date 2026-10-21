/* A real X click (XTEST) at root coordinates, for E2E tests that need the window system's own focus order (a click
 * that both activates a window and focuses one of its views). Built by test/helpers/xclick.ts on Linux; tests that
 * need it skip when it cannot be built. Usage: xclick X Y [button]. */
#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern int XTestFakeMotionEvent(Display *, int, int, int, unsigned long);
extern int XTestFakeButtonEvent(Display *, unsigned int, int, unsigned long);
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  Display *d = XOpenDisplay(NULL);
  if (!d) {
    fprintf(stderr, "no display\n");
    return 1;
  }
  int x = atoi(argv[1]), y = atoi(argv[2]);
  unsigned b = argc > 3 ? (unsigned)atoi(argv[3]) : 1;
  XTestFakeMotionEvent(d, -1, x, y, CurrentTime);
  XFlush(d);
  usleep(50000);
  XTestFakeButtonEvent(d, b, True, CurrentTime);
  XFlush(d);
  usleep(60000);
  XTestFakeButtonEvent(d, b, False, CurrentTime);
  XFlush(d);
  usleep(50000);
  XCloseDisplay(d);
  return 0;
}
