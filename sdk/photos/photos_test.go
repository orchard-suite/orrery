package photos

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sync"
	"testing"

	"github.com/orchard-suite/orrery/sdk"
)

// photoOf is a w by h PNG: red on its left half, blue on its right, with
// noise when noisy so a JPEG of it is heavy.
func photoOf(t *testing.T, w, h int, noisy bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	r := rand.New(rand.NewPCG(1, 2))
	for y := range h {
		for x := range w {
			c := color.RGBA{R: 220, A: 255}
			if x >= w/2 {
				c = color.RGBA{B: 220, A: 255}
			}
			if noisy {
				c = color.RGBA{R: uint8(r.IntN(256)), G: uint8(r.IntN(256)), B: uint8(r.IntN(256)), A: 255}
			}
			img.Set(x, y, c)
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestPortraitMakesTwoSquareJPEGsUnderTheirCaps(t *testing.T) {
	small, large, err := Portrait(photoOf(t, 640, 480, true))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		data       []byte
		side, most int
	}{{small, SmallSide, SmallBytes}, {large, LargeSide, LargeBytes}} {
		if !bytes.HasPrefix(c.data, []byte{0xff, 0xd8, 0xff}) {
			t.Fatalf("not a JPEG")
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(c.data))
		if err != nil || cfg.Width != c.side || cfg.Height != c.side {
			t.Fatalf("got %dx%d %v, want %d square", cfg.Width, cfg.Height, err, c.side)
		}
		if len(c.data) > c.most {
			t.Fatalf("%d bytes over %d", len(c.data), c.most)
		}
	}
}

func TestPortraitCropsTheCenteredSquare(t *testing.T) {
	if got := CenterSquare(image.Rect(0, 0, 300, 100)); got != image.Rect(100, 0, 200, 100) {
		t.Fatalf("wide: %v", got)
	}
	if got := CenterSquare(image.Rect(10, 10, 60, 210)); got != image.Rect(10, 85, 60, 135) {
		t.Fatalf("tall: %v", got)
	}
	// A wide photo red on its left and blue on its right keeps both halves
	// of its middle: the left edge of the square is red, the right blue.
	_, large, err := Portrait(photoOf(t, 900, 300, false))
	if err != nil {
		t.Fatal(err)
	}
	img, err := jpeg.Decode(bytes.NewReader(large))
	if err != nil {
		t.Fatal(err)
	}
	l, _, lb, _ := img.At(10, 128).RGBA()
	r, _, rb, _ := img.At(245, 128).RGBA()
	if l < 0x8000 || lb > 0x4000 || rb < 0x8000 || r > 0x4000 {
		t.Fatalf("left %x/%x right %x/%x", l, lb, r, rb)
	}
}

func TestSquareJPEGStepsQualityDownToFitAndFailsPastTheFloor(t *testing.T) {
	src, _, err := image.Decode(bytes.NewReader(photoOf(t, 256, 256, true)))
	if err != nil {
		t.Fatal(err)
	}
	full, err := squareJPEG(src, src.Bounds(), 256, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	fitted, err := squareJPEG(src, src.Bounds(), 256, len(full)-1)
	if err != nil || len(fitted) >= len(full) {
		t.Fatalf("got %d bytes from %d: %v", len(fitted), len(full), err)
	}
	if _, err := squareJPEG(src, src.Bounds(), 256, 100); err == nil {
		t.Fatal("a cap no quality meets must fail")
	}
}

func TestPortraitRefusesWhatIsNoImage(t *testing.T) {
	if _, _, err := Portrait([]byte("not an image")); err == nil {
		t.Fatal("want an error")
	}
}

// fakeHub holds pictures by address and notes what it was asked.
type fakeHub struct {
	mu      sync.Mutex
	held    map[string]string
	puts    []string
	deletes []string
}

func (h *fakeHub) Pictures(context.Context) ([]sdk.Picture, error) {
	var out []sdk.Picture
	for a, s := range h.held {
		out = append(out, sdk.Picture{Address: a, SHA256: s})
	}
	return out, nil
}

func (h *fakeHub) PutPicture(_ context.Context, a string, small, large []byte) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.puts = append(h.puts, a)
	return sdk.PictureSHA(small, large), nil
}

func (h *fakeHub) DeletePicture(_ context.Context, a string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.deletes = append(h.deletes, a)
	return nil
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestSyncPutsWhatMovedAndDeletesOnlyWhatIsSurelyGone(t *testing.T) {
	photo := photoOf(t, 300, 200, false)
	small, large, err := Portrait(photo)
	if err != nil {
		t.Fatal(err)
	}
	hub := &fakeHub{held: map[string]string{
		"same@example.org":    sdk.PictureSHA(small, large),
		"changed@example.org": "old",
		"none@example.org":    "old",
		"broken@example.org":  "old",
		"left@example.org":    "old",
	}}
	people := []Person{
		{ID: "same", Address: "Same@example.org"},
		{ID: "changed", Address: "changed@example.org"},
		{ID: "new", Address: "new@example.org"},
		{ID: "none", Address: "none@example.org"},
		{ID: "broken", Address: "broken@example.org"},
	}
	fetch := func(_ context.Context, id string) ([]byte, error) {
		switch id {
		case "none":
			return nil, nil
		case "broken":
			return nil, errors.New("graph down")
		}
		return photo, nil
	}
	got := Sync(context.Background(), hub, fetch, people, quiet())
	want := Tally{Fetched: 3, Put: 2, Unchanged: 1, Deleted: 2, None: 1, Failed: 1}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	slices.Sort(hub.puts)
	slices.Sort(hub.deletes)
	if !slices.Equal(hub.puts, []string{"changed@example.org", "new@example.org"}) {
		t.Fatalf("puts %v", hub.puts)
	}
	if !slices.Equal(hub.deletes, []string{"left@example.org", "none@example.org"}) {
		t.Fatalf("deletes %v: a failed read must delete nothing", hub.deletes)
	}
}

func TestSyncStopsWithoutDeletingWhenTheProviderRefuses(t *testing.T) {
	hub := &fakeHub{held: map[string]string{"left@example.org": "old", "a@example.org": "old"}}
	people := []Person{{ID: "a", Address: "a@example.org"}, {ID: "b", Address: "b@example.org"}}
	fetch := func(context.Context, string) ([]byte, error) { return nil, ErrDenied }
	got := Sync(context.Background(), hub, fetch, people, quiet())
	if !got.Denied || len(hub.deletes) != 0 || len(hub.puts) != 0 {
		t.Fatalf("got %+v, deletes %v", got, hub.deletes)
	}
}
