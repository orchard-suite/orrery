package photos

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"

	"github.com/orchard-suite/orrery/v2/sdk"
)

// workers is how many photos are read from the provider at once.
const workers = 8

// ErrDenied is a read the provider refused for want of a permission. A
// Fetch wraps it, and Sync stops before it removes anything.
var ErrDenied = errors.New("photos: the provider refused the read")

// Hub is the part of the hub a photo sync talks to. *sdk.Client is one.
type Hub interface {
	Pictures(ctx context.Context) ([]sdk.Picture, error)
	PutPicture(ctx context.Context, address string, small, large []byte) (string, error)
	DeletePicture(ctx context.Context, address string) error
}

// Person is one person whose photo is read: the address the hub keeps their
// picture under, which must be the address their person entity answers to
// (its key, or the person setting's field), and the id the provider reads
// the photo by.
type Person struct {
	Address string
	ID      string
}

// Fetch reads one person's photo by their id. No data and no error means
// they have none; an error wrapping ErrDenied means no photo may be read.
type Fetch func(ctx context.Context, id string) ([]byte, error)

// Tally is what one sync did.
type Tally struct {
	Fetched, Put, Unchanged, Deleted, None, Failed int
	// Denied is a sync the provider refused, which changed nothing.
	Denied bool
}

// Sync puts each person's photo on the hub where it differs from what the
// hub holds, and removes a photo the hub holds only where the provider said
// the person has none or the person is no longer among people. A read that
// failed removes nothing, and a refused read stops the sync before it
// removes anything. Only the photos this source put are listed, so another
// source's are never touched.
func Sync(ctx context.Context, hub Hub, fetch Fetch, people []Person, log *slog.Logger) Tally {
	var tally Tally
	list, err := hub.Pictures(ctx)
	if err != nil {
		log.Warn("photos skipped: the hub's list failed", "error", err)
		return tally
	}
	held := map[string]string{}
	for _, p := range list {
		held[strings.ToLower(p.Address)] = p.SHA256
	}
	byAddress := map[string]string{}
	var addresses []string
	for _, p := range people {
		a := strings.ToLower(strings.TrimSpace(p.Address))
		if a == "" || p.ID == "" {
			continue
		}
		if _, ok := byAddress[a]; !ok {
			byAddress[a] = p.ID
			addresses = append(addresses, a)
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		mu   sync.Mutex
		none []string
		work = make(chan string)
		pool sync.WaitGroup
	)
	count := func(f func()) { mu.Lock(); f(); mu.Unlock() }
	for range workers {
		pool.Go(func() {
			for a := range work {
				if ctx.Err() != nil {
					continue
				}
				data, err := fetch(ctx, byAddress[a])
				switch {
				case errors.Is(err, ErrDenied):
					count(func() { tally.Denied = true })
					cancel()
					continue
				case err != nil:
					log.Warn("photo failed: read", "id", byAddress[a], "error", err)
					count(func() { tally.Failed++ })
					continue
				case data == nil:
					count(func() { tally.None++; none = append(none, a) })
					continue
				}
				count(func() { tally.Fetched++ })
				small, large, err := Portrait(data)
				if err != nil {
					log.Warn("photo failed: image", "id", byAddress[a], "error", err)
					count(func() { tally.Failed++ })
					continue
				}
				if held[a] == sdk.PictureSHA(small, large) {
					count(func() { tally.Unchanged++ })
					continue
				}
				if _, err := hub.PutPicture(ctx, a, small, large); err != nil {
					log.Warn("photo failed: put", "id", byAddress[a], "error", err)
					count(func() { tally.Failed++ })
					continue
				}
				count(func() { tally.Put++ })
			}
		})
	}
	for _, a := range addresses {
		work <- a
	}
	close(work)
	pool.Wait()

	if tally.Denied {
		log.Warn("photos skipped: the provider refused to read them")
		return tally
	}
	if ctx.Err() != nil {
		return tally
	}
	var gone []string
	for _, a := range none {
		if _, ok := held[a]; ok {
			gone = append(gone, a)
		}
	}
	for a := range held {
		if _, ok := byAddress[a]; !ok {
			gone = append(gone, a)
		}
	}
	for _, a := range gone {
		if err := hub.DeletePicture(ctx, a); err != nil {
			log.Warn("photo failed: delete", "address", a, "error", err)
			tally.Failed++
			continue
		}
		tally.Deleted++
	}
	return tally
}
