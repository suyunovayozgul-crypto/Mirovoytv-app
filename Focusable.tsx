// ═══════════════════════════════════════════════════════════════════════
//  Focusable.tsx
//
//  Telefon/planshetda oddiy tugma kabi ishlaydi (bosilganda onPress
//  chaqiriladi). Android TV pultida esa D-pad (yuqoriga/pastga/
//  chapga/o'ngga) bilan o'tilganda "fokus" holatini oladi — shunda
//  focusStyle qo'shimcha stil sifatida qo'llanadi (masalan chegara
//  yoki fon rangi bilan ajratib ko'rsatiladi), foydalanuvchi pultda
//  qaysi tugmada turganini ko'radi. Markazga (OK) bosilganda onPress
//  ishlaydi.
//
//  hasTVPreferredFocus — TV'da ekran ochilganda qaysi tugma birinchi
//  bo'lib avtomatik fokusda turishini belgilaydi (masalan "Qayta
//  urinish" tugmasi).
// ═══════════════════════════════════════════════════════════════════════
import React, { useState } from 'react';
import { Pressable, StyleProp, ViewStyle } from 'react-native';

type FocusableProps = {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle> | StyleProp<ViewStyle>[];
  focusStyle?: StyleProp<ViewStyle>;
  hitSlop?: { top?: number; bottom?: number; left?: number; right?: number };
  hasTVPreferredFocus?: boolean;
  disabled?: boolean;
};

export default function Focusable({
  children,
  onPress,
  style,
  focusStyle,
  hitSlop,
  hasTVPreferredFocus,
  disabled,
}: FocusableProps) {
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      hitSlop={hitSlop}
      disabled={disabled}
      // Android TV / tvOS'da qaysi element ekran ochilganda avtomatik
      // fokusda turishini belgilaydi. Telefon/planshetda bu prop
      // e'tiborga olinmaydi — xato bermaydi.
      // @ts-ignore — bu prop faqat TV platformalarida mavjud, lekin
      // React Native uni boshqa platformalarda jimgina e'tiborsiz qoldiradi
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={{ color: 'rgba(255,255,255,0.12)', borderless: true }}
      style={(state: { pressed: boolean }) => [
        style,
        focused && (focusStyle || DEFAULT_FOCUS_STYLE),
        state.pressed && PRESSED_STYLE,
        disabled && DISABLED_STYLE,
      ]}
    >
      {children}
    </Pressable>
  );
}

const DEFAULT_FOCUS_STYLE: ViewStyle = {
  borderWidth: 2,
  borderColor: '#8b5cf6',
};

const PRESSED_STYLE: ViewStyle = {
  opacity: 0.75,
};

const DISABLED_STYLE: ViewStyle = {
  opacity: 0.4,
};
