// Package photos makes a person's photo into the two JPEGs an Orrery hub
// keeps, and keeps a hub's photos in step with an identity provider's. Any
// pusher that reads people's photos calls it: it knows the hub, never the
// provider, which a pusher reads through a Fetch.
package photos

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"

	"golang.org/x/image/draw"
)

// The two sizes the hub keeps a person's photo at, and the most each JPEG
// may weigh.
const (
	SmallSide  = 64
	SmallBytes = 16 << 10
	LargeSide  = 256
	LargeBytes = 64 << 10
)

// MaxBytes is the largest photo a pusher should read from its provider.
const MaxBytes = 4 << 20

// photoQuality is the JPEG quality a photo is first encoded at; a photo
// over its cap is encoded again a step lower, down to the floor.
const (
	photoQuality = 82
	photoStep    = 8
	photoFloor   = 30
)

// Portrait turns a photo (JPEG, PNG, or GIF) into the two JPEGs the hub
// keeps: the centered square of it, at SmallSide and LargeSide.
func Portrait(data []byte) (small, large []byte, err error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, nil, fmt.Errorf("photo: %w", err)
	}
	square := CenterSquare(src.Bounds())
	if square.Empty() {
		return nil, nil, errors.New("photo: empty image")
	}
	if small, err = squareJPEG(src, square, SmallSide, SmallBytes); err != nil {
		return nil, nil, err
	}
	if large, err = squareJPEG(src, square, LargeSide, LargeBytes); err != nil {
		return nil, nil, err
	}
	return small, large, nil
}

// CenterSquare is the largest square centered in b.
func CenterSquare(b image.Rectangle) image.Rectangle {
	side := min(b.Dx(), b.Dy())
	x := b.Min.X + (b.Dx()-side)/2
	y := b.Min.Y + (b.Dy()-side)/2
	return image.Rect(x, y, x+side, y+side)
}

// squareJPEG scales the square of src to side by side over white, so a
// transparent photo reads as it would on a page, and encodes it at most
// limit bytes.
func squareJPEG(src image.Image, square image.Rectangle, side, limit int) ([]byte, error) {
	dst := image.NewRGBA(image.Rect(0, 0, side, side))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, square, draw.Over, nil)
	for q := photoQuality; q >= photoFloor; q -= photoStep {
		var out bytes.Buffer
		if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: q}); err != nil {
			return nil, err
		}
		if out.Len() <= limit {
			return out.Bytes(), nil
		}
	}
	return nil, fmt.Errorf("photo: over %d bytes at %d by %d even at quality %d", limit, side, side, photoFloor)
}
