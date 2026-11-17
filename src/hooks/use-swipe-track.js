import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Animated, Easing, PanResponder } from 'react-native';

const SWIPE_SLOP = 8;
const HOLD_CANCEL_SLOP = 10;
const SETTLE_DURATION = 180;

/**
 * Horizontal paging for a track of slides laid out at absolute page positions
 * (`index * frameWidth`). A committed swipe ends with the track already resting
 * on the incoming slide, so selecting it never re-bases styles or snaps.
 *
 * Without `onHoldStart`, the track only claims horizontal moves, leaving taps
 * and vertical drags to children (the Edit image crop canvas relies on this).
 * With `onHoldStart`, it claims the touch immediately: holding still for
 * `holdDelay` starts a hold (used for compare) that lasts until release, while
 * a horizontal drag before then becomes a swipe.
 *
 * `onSelect(index, fromSwipe)` may return a boolean or a promise of one; a
 * falsy result springs the track back to the current slide.
 */
export function useSwipeTrack({
  count,
  activeIndex,
  frameWidth,
  disabled = false,
  isBlocked,
  onSelect,
  onSwipeStart,
  onHoldStart,
  onHoldEnd,
  holdDelay = 180,
}) {
  const trackX = useRef(new Animated.Value(0)).current;
  const animatingRef = useRef(false);
  const gestureRef = useRef(null);
  const stateRef = useRef(null);
  stateRef.current = {
    count, activeIndex, frameWidth, disabled, isBlocked, onSelect, onSwipeStart, onHoldStart, onHoldEnd, holdDelay,
  };

  const responder = useMemo(() => {
    const canClaim = () => {
      const state = stateRef.current;
      return Boolean(state) && !state.disabled && !animatingRef.current && !state.isBlocked?.();
    };
    const isHorizontalSwipe = (gesture) => Math.abs(gesture.dx) > SWIPE_SLOP &&
      Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2;
    const restOffset = (state) => -state.activeIndex * Math.max(1, state.frameWidth);
    const springToRest = () => {
      const state = stateRef.current;
      animatingRef.current = true;
      Animated.spring(trackX, {
        toValue: state ? restOffset(state) : 0, bounciness: 0, speed: 18, useNativeDriver: false,
      }).start(() => { animatingRef.current = false; });
    };
    const clearHoldTimer = (gesture) => {
      if (gesture?.timer) clearTimeout(gesture.timer);
      if (gesture) gesture.timer = null;
    };
    const endHold = (gesture) => {
      if (!gesture?.holding) return;
      gesture.holding = false;
      stateRef.current?.onHoldEnd?.();
    };
    const beginSwipe = (gesture) => {
      clearHoldTimer(gesture);
      gesture.swiping = true;
      trackX.stopAnimation();
      stateRef.current?.onSwipeStart?.();
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => Boolean(stateRef.current?.onHoldStart) && canClaim(),
      onMoveShouldSetPanResponder: (_, gesture) => canClaim() && stateRef.current.count > 1 &&
        isHorizontalSwipe(gesture),
      onPanResponderGrant: () => {
        const state = stateRef.current;
        const current = { swiping: false, holding: false, timer: null };
        gestureRef.current = current;
        if (state?.onHoldStart) {
          // Touch-start claim: decide between hold and swipe as the touch develops.
          current.timer = setTimeout(() => {
            current.timer = null;
            if (gestureRef.current !== current || current.swiping) return;
            current.holding = true;
            stateRef.current?.onHoldStart?.();
          }, state.holdDelay);
        } else {
          beginSwipe(current);
        }
      },
      onPanResponderMove: (_, gesture) => {
        const current = gestureRef.current;
        const state = stateRef.current;
        if (!current || !state || current.holding) return;
        if (!current.swiping) {
          if (state.count > 1 && isHorizontalSwipe(gesture)) beginSwipe(current);
          else if (Math.abs(gesture.dx) > HOLD_CANCEL_SLOP || Math.abs(gesture.dy) > HOLD_CANCEL_SLOP) {
            clearHoldTimer(current);
          }
          if (!current.swiping) return;
        }
        let dx = gesture.dx;
        const width = Math.max(1, state.frameWidth);
        // Rubber-band at the first and last image so the edges feel intentional.
        if ((state.activeIndex <= 0 && dx > 0) || (state.activeIndex >= state.count - 1 && dx < 0)) {
          dx *= 0.35;
        }
        trackX.setValue(-state.activeIndex * width + dx);
      },
      onPanResponderRelease: (_, gesture) => {
        const current = gestureRef.current;
        gestureRef.current = null;
        clearHoldTimer(current);
        if (current?.holding) {
          endHold(current);
          return;
        }
        if (!current?.swiping) return;
        const state = stateRef.current;
        if (!state) return;
        const width = Math.max(1, state.frameWidth);
        const threshold = Math.max(48, width * 0.22);
        const toNext = gesture.dx < -threshold || (gesture.dx < -12 && gesture.vx < -0.5);
        const toPrevious = gesture.dx > threshold || (gesture.dx > 12 && gesture.vx > 0.5);
        const target = toNext ? state.activeIndex + 1
          : toPrevious ? state.activeIndex - 1 : state.activeIndex;
        if (target === state.activeIndex || target < 0 || target >= state.count) {
          springToRest();
          return;
        }
        animatingRef.current = true;
        Animated.timing(trackX, {
          toValue: -target * width,
          duration: SETTLE_DURATION,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }).start(({ finished }) => {
          if (!finished) {
            animatingRef.current = false;
            return;
          }
          Promise.resolve()
            .then(() => state.onSelect?.(target, true))
            .catch(() => false)
            .then((selected) => {
              if (selected) {
                animatingRef.current = false;
                return;
              }
              springToRest();
            });
        });
      },
      onPanResponderTerminate: () => {
        const current = gestureRef.current;
        gestureRef.current = null;
        clearHoldTimer(current);
        endHold(current);
        springToRest();
      },
      onPanResponderTerminationRequest: () => false,
    });
  }, [trackX]);

  useEffect(() => () => {
    const current = gestureRef.current;
    gestureRef.current = null;
    if (current?.timer) clearTimeout(current.timer);
  }, []);

  // External selection changes and layout changes reposition the track. A
  // committed swipe has already animated to exactly this value, so this is a
  // no-op for that hand-off and cannot repaint the outgoing slide.
  useLayoutEffect(() => {
    animatingRef.current = false;
    trackX.stopAnimation();
    trackX.setValue(-activeIndex * frameWidth);
  }, [activeIndex, frameWidth, trackX]);

  const resetTrack = () => {
    animatingRef.current = false;
    trackX.stopAnimation();
    trackX.setValue(-stateRef.current.activeIndex * stateRef.current.frameWidth);
  };

  return { trackX, panHandlers: responder.panHandlers, resetTrack };
}

/** Indices of the active slide and its immediate neighbours. */
export function getNeighbourIndices(activeIndex, count) {
  const indices = [];
  for (let index = Math.max(0, activeIndex - 1); index <= Math.min(count - 1, activeIndex + 1); index += 1) {
    indices.push(index);
  }
  return indices;
}
