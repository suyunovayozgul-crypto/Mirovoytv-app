// ═══════════════════════════════════════════════════════════════════════
//  Focusable — TouchableOpacity o'rniga ishlatiladi. Telefon/planshetda
//  oddiy bosiladigan tugma, Android TV'da esa PULT (D-pad) bilan
//  boshqarilganda FOKUS holatini (ramka + kattalashuv) ko'rsatadi.
//
//  Nega kerak: Android TV'da sichqoncha yo'q, foydalanuvchi faqat
//  yuqori/past/chap/o'ng va OK tugmalari bilan yuradi. Agar ekranda
//  qaysi element "faol" ekani ko'rinmasa, foydalanuvchi qayerda
//  turganini bilmay qoladi. React Native'ning o'zi TV'da fokusni
//  avtomatik boshqaradi (hech qanday qo'shimcha kutubxonasiz) — bizga
//  faqat fokusni KO'RSATISH kerak, shuning uchun onFocus/onBlur orqali
//  stil o'zgartiramiz.
// ═══════════════════════════════════════════════════════════════════════
import React, { useState } from 'react';
import { TouchableOpacity, Platform, StyleProp, ViewStyle } from 'react-native';

type Props = {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  focusStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  hasTVPreferredFocus?: boolean;
  hitSlop?: { top: number; bottom: number; left: number; right: number };
};

export default function Focusable({
  onPress,
  style,
  focusStyle,
  children,
  hasTVPreferredFocus,
  hitSlop,
}: Props) {
  const [focused, setFocused] = useState(false);
  const isTV = Platform.isTV;

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      onFocus={() => isTV && setFocused(true)}
      onBlur={() => isTV && setFocused(false)}
      hasTVPreferredFocus={hasTVPreferredFocus}
      hitSlop={hitSlop}
      // @ts-ignore — TV'da parallax animatsiyasini o'chiramiz (soddaroq va tezroq)
      tvParallaxProperties={{ enabled: false }}
      style={[
        style,
        focused && (focusStyle || DEFAULT_FOCUS_STYLE),
      ]}
    >
      {children}
    </TouchableOpacity>
  );
}

const DEFAULT_FOCUS_STYLE: ViewStyle = {
  borderWidth: 2,
  borderColor: '#8b5cf6',
  transform: [{ scale: 1.06 }],
  shadowColor: '#8b5cf6',
  shadowOpacity: 0.7,
  shadowRadius: 10,
  elevation: 10,
};
